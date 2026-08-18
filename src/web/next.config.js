const isAmplifyStaticExport = process.env.AMPLIFY_STATIC_EXPORT === "1";
const isE2EServer = process.env.NEXT_E2E_SERVER === "1";
const defaultApiBase =
  process.env.NODE_ENV === "production"
    ? "https://api.releviz.com"
    : "http://localhost:4000";
const apiBase = (
  process.env.NEXT_PUBLIC_API_BASE_URL || defaultApiBase
).replace(/\/+$/, "");
const apiOrigin = new URL(apiBase).origin;
const isDevelopment = process.env.NODE_ENV === "development";

// Next.js emits inline bootstrap scripts for static and cached pages. Removing
// unsafe-inline requires request-scoped nonces and fully dynamic rendering, so
// keep that single compatibility exception while excluding eval in production.
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ""} https://challenges.cloudflare.com`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  `connect-src 'self' ${apiOrigin} https://challenges.cloudflare.com${isDevelopment ? " ws: wss:" : ""}`,
  "frame-src 'self' https://challenges.cloudflare.com",
  "form-action 'self'",
  ...(isDevelopment || isE2EServer ? [] : ["upgrade-insecure-requests"]),
].join("; ");

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
            value: `${contentSecurityPolicy};`,
          },
        ],
      },
    ];
  },
};

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(isE2EServer
    ? {}
    : { output: isAmplifyStaticExport ? "export" : "standalone" }),
  skipTrailingSlashRedirect: true,
  ...(isAmplifyStaticExport
    ? {
        images: { unoptimized: true },
      }
    : serverConfig),
};

module.exports = nextConfig;
