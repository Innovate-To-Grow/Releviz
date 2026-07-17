import "./globals.css";
import { AuthProvider } from "@/components/auth/AuthContext";
import SiteFooter from "@/components/ui/SiteFooter";

export const metadata = {
  title: "Releviz",
  icons: { icon: "/img/i2glogo.png" },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <div className="site-shell">
            <div className="site-content">{children}</div>
            <SiteFooter />
          </div>
        </AuthProvider>
      </body>
    </html>
  );
}
