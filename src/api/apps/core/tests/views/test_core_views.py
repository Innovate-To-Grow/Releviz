from datetime import UTC, datetime
from xml.etree import ElementTree

from django.test import RequestFactory, TestCase
from django.test.utils import override_settings

from apps.cms.models import CMSBlock, CMSPage
from apps.core.views import custom_404

SITEMAP_NS = "{http://www.sitemaps.org/schemas/sitemap/0.9}"


class RobotsTxtTest(TestCase):
    def test_returns_text_plain(self):
        response = self.client.get("/robots.txt")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "text/plain")

    def test_disallows_all(self):
        response = self.client.get("/robots.txt")
        content = response.content.decode()
        self.assertIn("User-agent: *", content)
        self.assertIn("Disallow: /", content)


@override_settings(FRONTEND_URL="https://i2g.ucmerced.edu")
class SitemapXmlTest(TestCase):
    def sitemap_locations(self, response):
        root = ElementTree.fromstring(response.content)
        return [node.text for node in root.findall(f"{SITEMAP_NS}url/{SITEMAP_NS}loc")]

    def test_returns_valid_xml(self):
        response = self.client.get("/sitemap.xml")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response["Content-Type"].startswith("application/xml"))
        root = ElementTree.fromstring(response.content)
        self.assertEqual(root.tag, f"{SITEMAP_NS}urlset")

    def test_includes_published_cms_pages_with_frontend_urls(self):
        CMSPage.objects.create(slug="home", route="/", title="Home", status="published")
        CMSPage.objects.create(slug="about", route="/about", title="About", status="published")

        response = self.client.get("/sitemap.xml")

        self.assertEqual(
            self.sitemap_locations(response),
            [
                "https://i2g.ucmerced.edu/",
                "https://i2g.ucmerced.edu/about",
            ],
        )

    def test_excludes_unpublished_cms_pages(self):
        CMSPage.objects.create(slug="published", route="/published", title="Published", status="published")
        CMSPage.objects.create(slug="draft", route="/draft", title="Draft", status="draft")
        CMSPage.objects.create(slug="archived", route="/archived", title="Archived", status="archived")

        response = self.client.get("/sitemap.xml")

        self.assertEqual(self.sitemap_locations(response), ["https://i2g.ucmerced.edu/published"])

    def test_uses_latest_block_update_for_lastmod(self):
        old = datetime(2026, 1, 1, 12, 0, 0, tzinfo=UTC)
        new = datetime(2026, 1, 2, 15, 30, 45, tzinfo=UTC)
        page = CMSPage.objects.create(slug="content", route="/content", title="Content", status="published")
        block = CMSBlock.objects.create(page=page, block_type="hero", sort_order=0, data={})
        CMSPage.objects.filter(pk=page.pk).update(published_at=old, updated_at=old)
        CMSBlock.objects.filter(pk=block.pk).update(updated_at=new)

        response = self.client.get("/sitemap.xml")

        self.assertIn("<lastmod>2026-01-02T15:30:45Z</lastmod>", response.content.decode())

    def test_empty_sitemap_has_empty_urlset(self):
        response = self.client.get("/sitemap.xml")
        root = ElementTree.fromstring(response.content)
        self.assertEqual(root.tag, f"{SITEMAP_NS}urlset")
        self.assertEqual(root.findall(f"{SITEMAP_NS}url"), [])


class CanonicalFrontendBaseTest(TestCase):
    def test_falls_back_to_request_host_when_no_frontend_url(self):
        from apps.core.views import _canonical_frontend_base

        request = RequestFactory().get("/sitemap.xml")
        with override_settings(FRONTEND_URL=""):
            base = _canonical_frontend_base(request)
        # build_absolute_uri("/") on testserver, trailing slash stripped.
        self.assertEqual(base, "http://testserver")

    def test_sitemap_uses_request_host_without_frontend_url(self):
        CMSPage.objects.create(slug="home", route="/", title="Home", status="published")
        with override_settings(FRONTEND_URL=""):
            response = self.client.get("/sitemap.xml")
        self.assertIn("<loc>http://testserver/</loc>", response.content.decode())


class SitemapLastmodTest(TestCase):
    def test_returns_empty_when_no_timestamps(self):
        from apps.core.views import _sitemap_lastmod

        class _FakePage:
            updated_at = None
            published_at = None
            latest_block_updated_at = None

        self.assertEqual(_sitemap_lastmod(_FakePage()), "")


class Custom404Test(TestCase):
    def test_returns_404_status(self):
        factory = RequestFactory()
        request = factory.get("/nonexistent")
        response = custom_404(request, exception=None)
        self.assertEqual(response.status_code, 404)


class RootIndexTest(TestCase):
    def test_returns_200(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
