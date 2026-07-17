import Link from "next/link";

const footerLinks = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/support", label: "Support" },
  { href: "/feedback", label: "Report a problem" },
];

export default function SiteFooter() {
  return (
    <footer className="site-footer">
      <Link className="site-footer-brand" href="/">
        Releviz
      </Link>
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
