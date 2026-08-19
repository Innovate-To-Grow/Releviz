import { AuthProvider } from "@/components/auth/AuthContext";
import SiteFooter from "@/components/ui/SiteFooter";

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

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          {children}
          <SiteFooter />
        </AuthProvider>
      </body>
    </html>
  );
}
