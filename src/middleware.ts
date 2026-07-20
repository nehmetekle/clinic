import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@/server/session-constants";

// Edge-safe checks only — Prisma doesn't run on the Edge runtime, so this
// middleware is never the source of truth for "is this session actually
// valid" (that's `getServerUser()` in `(app)/layout.tsx` for pages, and the
// session lookup inside every `/api/*` route for API calls). It only handles
// what's cheap to check without a DB: cookie *presence* (a fast redirect for
// the common "never logged in" case) and the CSRF marker header on mutations.
const PUBLIC_APP_PATHS = ["/login"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (pathname.startsWith("/api/")) {
    // A cross-site page can trigger a request that rides along on the
    // session cookie automatically, but (with no CORS policy configured
    // here) can't set a custom header without a preflight this app never
    // approves — so requiring this header on mutations blocks forged
    // cross-site writes. Every mutating call in src/lib/api.ts sends it.
    if (req.method !== "GET" && !req.headers.get("x-nutriclinic-fetch")) {
      return NextResponse.json({ error: "Missing CSRF header" }, { status: 403 });
    }
    return NextResponse.next();
  }

  const hasSessionCookie = Boolean(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!PUBLIC_APP_PATHS.includes(pathname) && !hasSessionCookie) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
