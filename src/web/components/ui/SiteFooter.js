import Link from "next/link";
import { BrandHomeLink } from "@/components/ui/BrandLogo";

const footerLinks = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
];

export default function SiteFooter() {
  // Inlined at build time; empty outside the release pipeline.
  const releaseSha = (process.env.NEXT_PUBLIC_RELEASE_SHA || "").trim();
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <BrandHomeLink
          className="site-footer-brand"
          logoClassName="brand-logo brand-logo--footer"
        />
        <nav aria-label="Footer">
          <ul className="site-footer-links">
            {footerLinks.map((link) => (
              <li key={link.href}>
                <Link href={link.href}>{link.label}</Link>
              </li>
            ))}
          </ul>
        </nav>
        {releaseSha && (
          <p
            className="site-footer-release"
            data-release={releaseSha}
            title={releaseSha}
          >
            Release {releaseSha.slice(0, 7)}
          </p>
        )}
      </div>
    </footer>
  );
}
