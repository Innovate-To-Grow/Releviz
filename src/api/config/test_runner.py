from django.test.runner import DiscoverRunner


class AppTestRunner(DiscoverRunner):
    default_labels = ["apps.authn", "apps.core", "apps.mail", "apps.scheduling"]

    def run_tests(self, test_labels, **kwargs):
        return super().run_tests(test_labels or self.default_labels, **kwargs)
