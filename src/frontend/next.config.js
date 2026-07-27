const isAmplifyStaticExport = process.env.AMPLIFY_STATIC_EXPORT === "1";

const serverConfig = {
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://challenges.cloudflare.com blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ws: wss:; worker-src 'self' blob:; frame-src https://challenges.cloudflare.com;",
          },
        ],
      },
    ];
  },
  async rewrites() {
    const backendUrl = process.env.BACKEND_URL || "http://localhost:4000";
    const authnRoutes = [
      "public-key",
      "register",
      "register/verify-code",
      "register/resend-code",
      "login",
      "login/request-code",
      "login/verify-code",
      "email-auth/request-code",
      "email-auth/verify-code",
      "phone-auth/request-code",
      "phone-auth/verify-code",
      "logout",
      "refresh",
      "profile",
      "sessions",
      "account-emails",
      "contact-phones",
      "password-reset/request-code",
      "password-reset/verify-code",
      "password-reset/confirm",
      "change-password",
      "delete-account",
    ];
    return [
      ...authnRoutes.flatMap((route) => [
        { source: `/authn/${route}`, destination: `${backendUrl}/authn/${route}/` },
        { source: `/authn/${route}/`, destination: `${backendUrl}/authn/${route}/` },
      ]),
      { source: "/api/:path*", destination: `${backendUrl}/api/:path*` },
      { source: "/authn/:path*", destination: `${backendUrl}/authn/:path*` },
    ];
  },
};

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: isAmplifyStaticExport ? "export" : "standalone",
  skipTrailingSlashRedirect: true,
  ...(isAmplifyStaticExport
    ? {
        images: { unoptimized: true },
      }
    : serverConfig),
};

module.exports = nextConfig;
