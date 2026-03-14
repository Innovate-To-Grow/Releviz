import "./globals.css";
import { AuthProvider } from "@/components/auth/AuthContext";

export const metadata = {
  title: "Relevis",
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
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
