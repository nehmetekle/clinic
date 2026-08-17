import { redirect } from "next/navigation";
import { getServerUser } from "@/server/session";
import { roleHome } from "@/lib/nav";
import type { Role } from "@/lib/types";

/**
 * Server-side page gate for a route only some roles may open.
 *
 * The app already redirects away from a forbidden route in `AppShell`, but that
 * runs in the BROWSER, after the page has been sent, mounted and rendered. It is
 * a navigation convenience, not a control: it can be skipped with JavaScript off,
 * raced by a slow session fetch, or simply removed in devtools.
 *
 * This mirrors the rule the app already applies to authentication itself — the
 * `(app)` layout's `getServerUser()` check is the authoritative gate and the
 * middleware is only a fast path. A permission gate deserves the same treatment.
 *
 * It is NOT the only defence, and is not treated as one: every API route still
 * checks the caller's role itself, and `redactForRole` still strips figures a
 * role may not see. This just means a forbidden page is never delivered at all.
 */
export async function requireRole(roles: Role[]) {
  const user = await getServerUser();
  // No session at all is the (app) layout's business; it redirects to /login.
  if (!user) redirect("/login");
  if (!roles.includes(user.role)) redirect(roleHome(user.role));
  return user;
}
