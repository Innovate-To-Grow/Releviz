import { AuthProvider } from "@/components/auth/AuthContext";
import SiteFooter from "@/components/ui/SiteFooter";
import "@/styles/tokens.css";
import "@/styles/base.css";
import "@/styles/layout.css";
import "@/styles/components.css";
import "@/styles/patterns.css";

export const metadata = {
  metadataBase: new URL("https://releviz.com"),
  title: "Releviz",
  description:
    "Create a group scheduling poll, collect availability, and find the best time to meet.",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/favicon.ico", type: "image/x-icon", sizes: "64x64" },
      { url: "/brand/releviz-mark.png", type: "image/png", sizes: "512x512" },
    ],
    shortcut: "/favicon.ico",
    apple: [{ url: "/apple-icon.png", type: "image/png", sizes: "180x180" }],
  },
  openGraph: {
    title: "Releviz",
    description:
      "Create a group scheduling poll, collect availability, and find the best time to meet.",
    url: "/",
    siteName: "Releviz",
    type: "website",
    images: [
      {
        url: "/opengraph-image.png",
        width: 1200,
        height: 630,
        alt: "Releviz",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Releviz",
    description:
      "Create a group scheduling poll, collect availability, and find the best time to meet.",
    images: ["/twitter-image.png"],
  },
};

export const viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f6f3" },
    { media: "(prefers-color-scheme: dark)", color: "#17181b" },
  ],
  colorScheme: "light dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <a className="rv-skip-link" href="#main">
            Skip to main content
          </a>
          <div className="rv-app">
            {children}
            <SiteFooter />
          </div>
        </AuthProvider>
      </body>
    </html>
  );
}
