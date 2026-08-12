import Link from "next/link";
import { BrandHomeLink } from "@/components/ui/BrandLogo";

const footerLinks = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/support", label: "Support" },
];

export default function SiteFooter() {
  return (
    <footer className="site-footer">
      <BrandHomeLink className="site-footer-brand" logoClassName="brand-logo brand-logo--footer" />
      <nav aria-label="Product and support">
        <ul className="site-footer-links">
          {footerLinks.map((link) => (
            <li key={link.href}>
              <Link href={link.href}>{link.label}</Link>
            </li>
          ))}
        </ul>
      </nav>
    </footer>
  );
}
