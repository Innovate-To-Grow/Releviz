import Link from "next/link";
import { BrandMark } from "@/components/ui/Icon";

// The footer stays deliberately minimal: brand plus the two legal documents.
const footerLinks = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
];

export default function SiteFooter() {
  return (
    <footer className="rv-footer">
      <div className="rv-footer__inner">
        <div className="rv-stack rv-stack--xs">
          <Link
            href="/"
            className="rv-brand rv-brand--sm"
            aria-label="Releviz home"
          >
            <BrandMark className="rv-brand__mark" />
            <span className="rv-brand__word">Releviz</span>
          </Link>
          <p className="rv-footer__note">
            Group scheduling without the back-and-forth.
          </p>
        </div>
        <nav aria-label="Legal">
          <ul className="rv-footer__links">
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
