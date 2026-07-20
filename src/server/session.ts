import { randomBytes, createHash } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { db } from "./db";
import type { Role } from "@/lib/types";
import { SESSION_COOKIE_NAME } from "./session-constants";

export { SESSION_COOKIE_NAME };

const ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 min, per docs/01-product-spec.md §3.1
// Avoid a DB write on every single request — only bump lastUsedAt if it's
// gone stale by more than this, while still updating it well within the
// inactivity timeout above.
const LASTUSED_THROTTLE_MS = 60 * 1000;

export const MAX_FAILED_LOGIN_ATTEMPTS = 5;
export const LOCKOUT_DURATION_MS = 2 * 60 * 1000;

const PENDING_2FA_TTL_MS = 5 * 60 * 1000; // 5 min
export const MAX_2FA_ATTEMPTS = 5;

export interface ResolvedUser {
  id: string;
  role: Role;
  name: string;
  email: string;
  totpEnabled: boolean;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Manual cookie-header parser, used where we only have a raw `Request`
 * (route handlers) rather than Next's `cookies()` (Server Components). */
export function getSessionTokenFromCookieHeader(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === SESSION_COOKIE_NAME) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** Creates a session row and returns the raw token (the only moment it
 * exists outside the client's cookie — only its hash is ever persisted). */
export async function createSession(
  userId: string,
  meta: { userAgent?: string | null; ip?: string | null } = {},
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  await db.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt: new Date(now + ABSOLUTE_TTL_MS),
      userAgent: meta.userAgent ?? null,
      ip: meta.ip ?? null,
    },
  });
  return token;
}

/** Resolves a raw session token to the user it belongs to, or null if the
 * token is missing/unknown/revoked/expired/inactivity-timed-out, or the
 * user it belongs to is no longer active. */
export async function resolveSessionToken(token: string | null): Promise<ResolvedUser | null> {
  if (!token) return null;

  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session || session.revokedAt || session.expiresAt < new Date()) return null;

  const now = Date.now();
  if (now - session.lastUsedAt.getTime() > INACTIVITY_TIMEOUT_MS) {
    await db.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    return null;
  }
  if (session.user.status !== "active") return null;

  if (now - session.lastUsedAt.getTime() > LASTUSED_THROTTLE_MS) {
    await db.session.update({ where: { id: session.id }, data: { lastUsedAt: new Date() } });
  }

  return {
    id: session.user.id,
    role: session.user.role as Role,
    name: session.user.fullName,
    email: session.user.email,
    totpEnabled: session.user.totpEnabled,
  };
}

export async function revokeSessionByToken(token: string | null): Promise<void> {
  if (!token) return;
  await db.session.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Force-logout every active session for a user — used when an admin
 * deactivates a staff account, so access ends immediately rather than at
 * the account's next natural session expiry. */
export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  await db.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export function attachSessionCookie(res: NextResponse, token: string): void {
  res.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ABSOLUTE_TTL_MS / 1000,
  });
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

/** For Server Components (no `Request` object available) — e.g. the
 * authenticated layout's server-side session gate. */
export async function getServerUser(): Promise<ResolvedUser | null> {
  const store = await cookies();
  return resolveSessionToken(store.get(SESSION_COOKIE_NAME)?.value ?? null);
}

// ---- Pending two-factor step (between a correct password and a real session) ----

/** Creates a pending-2FA record after a password check succeeds for a user
 * with totpEnabled, and returns the raw token to hand to the client. */
export async function createPendingTwoFactor(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.pendingTwoFactor.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt: new Date(Date.now() + PENDING_2FA_TTL_MS),
    },
  });
  return token;
}

/** Resolves a pending-2FA token to its row (with the user), or null if
 * missing/expired/attempts-exhausted. Does not consume it — the caller
 * decides whether to delete it (success) or bump attempts (failure). */
export async function resolvePendingTwoFactor(
  token: string | null,
): Promise<{ id: string; userId: string; user: ResolvedUser } | null> {
  if (!token) return null;
  const pending = await db.pendingTwoFactor.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!pending || pending.expiresAt < new Date() || pending.attempts >= MAX_2FA_ATTEMPTS) return null;
  if (pending.user.status !== "active") return null;
  return {
    id: pending.id,
    userId: pending.userId,
    user: {
      id: pending.user.id,
      role: pending.user.role as Role,
      name: pending.user.fullName,
      email: pending.user.email,
      totpEnabled: pending.user.totpEnabled,
    },
  };
}

export async function recordFailedTwoFactorAttempt(id: string): Promise<void> {
  await db.pendingTwoFactor.update({ where: { id }, data: { attempts: { increment: 1 } } });
}

export async function deletePendingTwoFactor(id: string): Promise<void> {
  await db.pendingTwoFactor.delete({ where: { id } }).catch(() => {});
}
