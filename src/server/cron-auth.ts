/**
 * Shared secret check for the routes that are driven by an external scheduler
 * rather than a signed-in user.
 *
 * FAILS CLOSED. The previous inline checks were shaped
 *
 *   const secret = process.env.CRON_SECRET;
 *   if (secret) { ...compare... }        // <- no secret configured => NO CHECK
 *
 * so a deployment that never set `CRON_SECRET` left those endpoints completely
 * open — and `.env.example` ships the key as an empty string, which is falsy, so
 * following the example verbatim produced exactly that. An unset secret is a
 * misconfiguration, not permission to skip authentication.
 */

/** Constant-time compare, so a wrong secret can't be recovered a byte at a time. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type CronAuthResult = { ok: true } | { ok: false; status: 401 | 503; error: string };

/**
 * Accepts the secret as `Authorization: Bearer <CRON_SECRET>` (what Vercel Cron
 * sends automatically) or as `?key=<CRON_SECRET>` (so a scheduler needs only a
 * URL). Anything else is refused.
 *
 * Returns 503 rather than 401 when no secret is configured: that is the server's
 * fault, not the caller's, and it makes the misconfiguration obvious in logs
 * instead of looking like a wrong credential.
 */
export function checkCronSecret(req: Request): CronAuthResult {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return {
      ok: false,
      status: 503,
      error: "This endpoint is disabled because CRON_SECRET is not configured.",
    };
  }
  const auth = req.headers.get("authorization");
  if (auth && safeEqual(auth, `Bearer ${secret}`)) return { ok: true };

  const key = new URL(req.url).searchParams.get("key");
  if (key && safeEqual(key, secret)) return { ok: true };

  return { ok: false, status: 401, error: "Unauthorized" };
}
