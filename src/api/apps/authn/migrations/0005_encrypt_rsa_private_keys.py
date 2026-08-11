"""
Data migration: encrypt existing RSA private keys at rest using Fernet.

Existing plaintext PEM values are encrypted in-place. The model's save()
method now handles encryption automatically for all future writes.
"""

from django.db import migrations


def encrypt_existing_keys(apps, schema_editor):
    """Encrypt all plaintext private keys in the RSAKeypair table."""
    from authn.services.security.key_encryption import encrypt_pem, is_encrypted

    RSAKeypair = apps.get_model("authn", "RSAKeypair")
    for keypair in RSAKeypair.objects.all():
        if keypair.private_key_pem and not is_encrypted(keypair.private_key_pem):
            keypair.private_key_pem = encrypt_pem(keypair.private_key_pem)
            keypair.save(update_fields=["private_key_pem"])


def noop_reverse(apps, schema_editor):
    """Reverse is a no-op; decrypt_pem() handles both formats transparently."""
    pass


class Migration(migrations.Migration):
    dependencies = [
        ("authn", "0004_member_title"),
    ]

    operations = [
        migrations.RunPython(encrypt_existing_keys, noop_reverse),
    ]
