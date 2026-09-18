import Link from "next/link";
import { BrandHomeLink } from "@/components/ui/BrandLogo";

const footerLinks = [
  { href: "/support", label: "Support" },
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
];

export default function SiteFooter() {
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
      </div>
    </footer>
  );
}
