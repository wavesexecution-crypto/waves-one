import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No CORS headers are set anywhere: browsers enforce same-origin, so
  // arbitrary websites cannot call the control-plane API. Never add
  // Access-Control-Allow-Origin to /api routes.
  poweredByHeader: false,
  async headers() {
    const production = process.env.NODE_ENV === "production";
    const csp = [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${production ? "" : " 'unsafe-eval'"}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      `connect-src 'self'${production ? "" : " ws: wss:"}`,
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      ...(production ? ["upgrade-insecure-requests"] : []),
    ].join("; ");
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
          ...(production ? [{ key: "Strict-Transport-Security", value: "max-age=31536000" }] : []),
        ],
      },
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
