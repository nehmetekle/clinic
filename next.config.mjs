const isProd = process.env.NODE_ENV === "production";

// A reasonably strict CSP given this app has no dangerouslySetInnerHTML and no
// third-party embeds. 'unsafe-inline' stays on script/style because Next.js's
// App Router injects inline hydration/streaming scripts and some inline
// styles; a nonce-based CSP would be stricter but is easy to get subtly wrong
// (breaks hydration silently) — this is the safe middle ground. 'unsafe-eval'
// is dev-only (webpack/Fast Refresh needs it; production builds don't).
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Content-Security-Policy", value: csp },
  // Meaningless (and browser-ignored) over plain http, so only sent in prod —
  // mirrors the secure-cookie-only-in-production pattern in server/session.ts.
  ...(isProd
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]
    : []),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Keep Prisma and the native argon2 binding out of the bundler so they
  // resolve at runtime instead of being (mis)packed by webpack/turbopack.
  serverExternalPackages: ["@prisma/client", "prisma", "@node-rs/argon2"],
  // The Food List PDF renderer reads its fonts and Layaka branding from disk at
  // runtime. Next's tracer can't see `fs` reads, so those files must be named
  // explicitly or they'd be missing from the serverless bundle in production —
  // the PDF route would work locally and 500 on Vercel.
  outputFileTracingIncludes: {
    "/api/consultations/[id]/food-list-pdf": [
      "./src/server/pdf/fonts/**",
      "./src/server/pdf/assets/**",
    ],
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
