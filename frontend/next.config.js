/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
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
    return [
      { source: "/api/:path*", destination: `${backendUrl}/api/:path*` },
      { source: "/authn/:path*", destination: `${backendUrl}/authn/:path*` },
    ];
  },
};

module.exports = nextConfig;
