"""Tests for apps.core.utils.security URL validation helpers."""

from urllib.parse import urlparse

from django.test import SimpleTestCase

from apps.core.utils.security import (
    SecurityValidationError,
    _is_allowed_sns_host,
    _is_safe_dns_label,
    validate_aws_sns_https_url,
)


class IsSafeDnsLabelTest(SimpleTestCase):
    def test_rejects_empty(self):
        self.assertFalse(_is_safe_dns_label(""))

    def test_rejects_too_long(self):
        self.assertFalse(_is_safe_dns_label("a" * 64))

    def test_rejects_leading_or_trailing_hyphen(self):
        self.assertFalse(_is_safe_dns_label("-abc"))
        self.assertFalse(_is_safe_dns_label("abc-"))

    def test_rejects_non_ascii_or_symbols(self):
        self.assertFalse(_is_safe_dns_label("ünïcode"))
        self.assertFalse(_is_safe_dns_label("ab_cd"))

    def test_accepts_alphanumeric_and_internal_hyphen(self):
        self.assertTrue(_is_safe_dns_label("us-west-2"))
        self.assertTrue(_is_safe_dns_label("sns"))


class IsAllowedSnsHostTest(SimpleTestCase):
    def test_exact_global_host(self):
        self.assertTrue(_is_allowed_sns_host("sns.amazonaws.com"))

    def test_exact_china_host(self):
        self.assertTrue(_is_allowed_sns_host("sns.amazonaws.com.cn"))

    def test_regional_sns_host(self):
        self.assertTrue(_is_allowed_sns_host("sns.us-west-2.amazonaws.com"))

    def test_rejects_non_sns_first_label(self):
        self.assertFalse(_is_allowed_sns_host("evil.us-west-2.amazonaws.com"))

    def test_rejects_unsafe_middle_label(self):
        self.assertFalse(_is_allowed_sns_host("sns.bad_label.amazonaws.com"))

    def test_rejects_unknown_suffix(self):
        self.assertFalse(_is_allowed_sns_host("sns.attacker.com"))


class ValidateAwsSnsHttpsUrlTest(SimpleTestCase):
    def test_accepts_valid_https_sns_url(self):
        url = "https://sns.us-west-2.amazonaws.com/?Action=ConfirmSubscription"
        result = validate_aws_sns_https_url(url)
        parsed = urlparse(result)
        self.assertEqual(parsed.scheme, "https")
        self.assertEqual(parsed.hostname, "sns.us-west-2.amazonaws.com")

    def test_strips_fragment(self):
        url = "https://sns.us-west-2.amazonaws.com/path#frag"
        result = validate_aws_sns_https_url(url)
        self.assertNotIn("#frag", result)

    def test_rejects_non_https(self):
        with self.assertRaises(SecurityValidationError) as cm:
            validate_aws_sns_https_url("http://sns.us-west-2.amazonaws.com/")
        self.assertIn("must be https", str(cm.exception))

    def test_rejects_credentials_in_url(self):
        with self.assertRaises(SecurityValidationError) as cm:
            validate_aws_sns_https_url("https://user:pass@sns.us-west-2.amazonaws.com/")
        self.assertIn("must not include credentials", str(cm.exception))

    def test_rejects_non_default_port(self):
        with self.assertRaises(SecurityValidationError) as cm:
            validate_aws_sns_https_url("https://sns.us-west-2.amazonaws.com:8443/")
        self.assertIn("default HTTPS port", str(cm.exception))

    def test_accepts_explicit_default_port(self):
        result = validate_aws_sns_https_url("https://sns.us-west-2.amazonaws.com:443/x")
        parsed = urlparse(result)
        self.assertEqual(parsed.scheme, "https")
        self.assertEqual(parsed.hostname, "sns.us-west-2.amazonaws.com")

    def test_rejects_disallowed_host(self):
        with self.assertRaises(SecurityValidationError) as cm:
            validate_aws_sns_https_url("https://evil.example.com/")
        self.assertIn("host is not allowed", str(cm.exception))

    def test_rejects_empty_url(self):
        with self.assertRaises(SecurityValidationError):
            validate_aws_sns_https_url("")
