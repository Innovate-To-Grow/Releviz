import uuid

from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from django.db import models, transaction
from django.utils import timezone

from apps.core.models import ProjectControlModel


class RSAKeypair(ProjectControlModel):
    """
    Stores an RSA keypair for the site (PEM formatted).
    """

    key_id = models.UUIDField(
        default=uuid.uuid4,
        editable=False,
        unique=True,
        help_text="Key identifier (UUID).",
    )

    # Optional display name to distinguish usages (e.g., signing, encryption).
    name = models.CharField(
        max_length=255,
        default="site-signing",
        help_text="label for this keypair.",
    )

    public_key_pem = models.TextField(blank=True, help_text="Public key in PEM format.")

    private_key_pem = models.TextField(blank=True, help_text="Private key in PEM format.")

    @property
    def decrypted_private_key_pem(self) -> str:
        """Return the plaintext private key PEM, decrypting if stored encrypted."""
        from apps.authn.services.security.key_encryption import decrypt_pem

        return decrypt_pem(self.private_key_pem)

    @classmethod
    def _get_key_encryption_algorithm(cls) -> serialization.KeySerializationEncryption:
        """
        Return encryption algorithm for private key PEM serialization.
        At-rest encryption is handled separately via Fernet in save().
        """
        return serialization.NoEncryption()

    @classmethod
    def generate_keypair(cls, key_size: int = 2048):
        """
        Generate a new RSA keypair and return (public_pem, private_pem).
        The private key is stored unencrypted.
        """
        private_key = rsa.generate_private_key(
            public_exponent=65537,
            key_size=key_size,
            backend=default_backend(),
        )

        private_pem = private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=cls._get_key_encryption_algorithm(),
        ).decode("utf-8")

        public_pem = (
            private_key.public_key()
            .public_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PublicFormat.SubjectPublicKeyInfo,
            )
            .decode("utf-8")
        )

        return public_pem, private_pem

    def save(self, *args, **kwargs):
        """
        Auto-generate keys if not provided, and encrypt the private key at rest.
        """
        from apps.authn.services.security.key_encryption import encrypt_pem, is_encrypted

        if not self.public_key_pem or not self.private_key_pem:
            self.public_key_pem, self.private_key_pem = self.generate_keypair()

        # Encrypt private key before writing to DB
        if self.private_key_pem and not is_encrypted(self.private_key_pem):
            self.private_key_pem = encrypt_pem(self.private_key_pem)

        super().save(*args, **kwargs)

    # Mark which keypair should be used for current operations.
    is_active = models.BooleanField(
        default=True,
        help_text="Whether this keypair is currently active.",
    )

    rotated_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        verbose_name = "RSA Keypair"
        verbose_name_plural = "RSA Keypairs"
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["name"],
                condition=models.Q(is_active=True),
                name="authn_one_active_rsa_name",
            ),
        ]

    def __str__(self):
        return f"{self.name} ({self.key_id})"

    @transaction.atomic
    def rotate(
        self,
        public_key_pem: str | None = None,
        private_key_pem: str | None = None,
    ):
        """Retire this key and return a newly created active key row.

        Rotation must never overwrite the private key identified by ``key_id``:
        clients may still submit ciphertext produced with that identifier during
        the decryption-retention window.
        """
        current = type(self).objects.select_for_update().get(pk=self.pk)
        if not current.is_active:
            raise ValueError("Only an active RSA keypair can be rotated.")

        if not public_key_pem or not private_key_pem:
            public_key_pem, private_key_pem = type(self).generate_keypair()

        retired_at = timezone.now()
        current.is_active = False
        current.rotated_at = retired_at
        current.save(update_fields=["is_active", "rotated_at", "updated_at"])

        replacement = type(self).objects.create(
            name=current.name,
            public_key_pem=public_key_pem,
            private_key_pem=private_key_pem,
            is_active=True,
        )
        self.is_active = False
        self.rotated_at = retired_at
        return replacement

    def deactivate(self):
        """
        Mark this keypair as inactive without deleting it.
        """
        self.is_active = False
        self.rotated_at = timezone.now()
        self.save(update_fields=["is_active", "rotated_at", "updated_at"])
