from unittest import TestCase

from scripts.ci.check_npm_audit import unapproved_advisories


class NpmAuditAllowlistTests(TestCase):
    def test_accepts_only_the_unpatched_deepmerge_advisory(self):
        report = {
            "vulnerabilities": {
                "deepmerge": {
                    "via": [
                        {
                            "url": "https://github.com/advisories/GHSA-gcqx-w48m-w2h4",
                            "severity": "low",
                            "title": "prototype poisoning",
                        }
                    ]
                },
                "jest-config": {"via": ["deepmerge"]},
                "jest": {"via": ["jest-config"]},
            }
        }
        self.assertEqual(unapproved_advisories(report), [])

    def test_rejects_any_other_advisory(self):
        report = {
            "vulnerabilities": {
                "deepmerge": {
                    "via": [
                        {
                            "url": "https://github.com/advisories/GHSA-gcqx-w48m-w2h4",
                            "severity": "low",
                            "title": "known exception",
                        },
                        {
                            "url": "https://github.com/advisories/GHSA-new-advisory",
                            "severity": "high",
                            "title": "new issue",
                        },
                    ]
                },
                "left-pad": {
                    "via": [
                        {
                            "url": "https://github.com/advisories/GHSA-other",
                            "severity": "moderate",
                            "title": "something else",
                        }
                    ]
                },
            }
        }
        findings = unapproved_advisories(report)
        self.assertEqual(len(findings), 2)
        self.assertTrue(any("GHSA-new-advisory" in finding for finding in findings))
        self.assertTrue(any("left-pad" in finding for finding in findings))
