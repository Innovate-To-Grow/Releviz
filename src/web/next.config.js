const isAmplifyStaticExport = process.env.AMPLIFY_STATIC_EXPORT === "1";
const defaultApiBase =
  process.env.NODE_ENV === "production"
    ? "https://api.releviz.com"
    : "http://localhost:4000";
const apiBase = (
  process.env.NEXT_PUBLIC_API_BASE_URL || defaultApiBase
).replace(/\/+$/, "");
const apiOrigin = new URL(apiBase).origin;

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
            value: `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://challenges.cloudflare.com blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ${apiOrigin} ws: wss:; worker-src 'self' blob:; frame-src https://challenges.cloudflare.com;`,
          },
        ],
      },
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
