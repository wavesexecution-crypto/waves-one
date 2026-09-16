import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No CORS headers are set anywhere: browsers enforce same-origin, so
  // arbitrary websites cannot call the control-plane API. Never add
  // Access-Control-Allow-Origin to /api routes.
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};

export default nextConfig;
