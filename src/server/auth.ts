import type { Role } from "@/lib/types";
import { getSessionTokenFromCookieHeader, resolveSessionToken, type ResolvedUser } from "./session";

/**
 * Resolves the acting user from the request's session cookie, memoized per
 * `Request` object (a WeakMap keyed on the request itself) so a handler that
 * calls several of the functions below only pays for one session lookup.
 */
const requestUserCache = new WeakMap<Request, Promise<ResolvedUser | null>>();

function resolveActingUser(req: Request): Promise<ResolvedUser | null> {
  let cached = requestUserCache.get(req);
  if (!cached) {
    const token = getSessionTokenFromCookieHeader(req.headers.get("cookie"));
    cached = resolveSessionToken(token);
    requestUserCache.set(req, cached);
  }
  return cached;
}

/**
 * Reads the acting user's role from the request's verified session.
 * Missing/invalid/expired session is treated as no clinical access (fail closed).
 */
export async function actingRole(req: Request): Promise<Role | null> {
  const user = await resolveActingUser(req);
  return user?.role ?? null;
}

export async function actingUser(req: Request): Promise<{
  id: string | null;
  role: Role | null;
  name: string;
  email?: string;
}> {
  const user = await resolveActingUser(req);
  return {
    id: user?.id ?? null,
    role: user?.role ?? null,
    name: user?.name ?? "Unknown user",
    email: user?.email,
  };
}

/** Clinical data (weight, measurements, consultations, medical notes) is for
 * the dietitian and admin only — the secretary/receptionist is front-desk. */
export async function canViewClinical(req: Request): Promise<boolean> {
  const role = await actingRole(req);
  return role === "dietitian" || role === "admin";
}

/** Money handling (recording payments, settling baskets) is the secretary's
 * (and admin's) domain — the dietitian never collects payment. */
export async function canHandleMoney(req: Request): Promise<boolean> {
  const role = await actingRole(req);
  return role === "secretary" || role === "admin";
}

/** Writing off (voiding) a tracked debt forgives money the clinic is owed — an
 * accountability event reserved for the admin. The secretary can collect a debt
 * (records a real payment) but never write one off. */
export async function canVoidDebt(req: Request): Promise<boolean> {
  return (await actingRole(req)) === "admin";
}

/** Lab-sample logistics (sending samples to the lab, logging results back) is a
 * front-desk task — the secretary owns it, the admin can step in. */
export async function canTrackSamples(req: Request): Promise<boolean> {
  const role = await actingRole(req);
  return role === "secretary" || role === "admin";
}

/** Attaching a lab-result file to a blood test can be done by anyone who touches
 * a sample: the secretary receives the result from the lab, the doctor ordered it
 * and may scan it in, the admin oversees. Reading/deleting the file content is the
 * narrower clinical right — that's `canViewClinical` (doctor/admin only). */
export async function canAttachSampleFile(req: Request): Promise<boolean> {
  const role = await actingRole(req);
  return role === "secretary" || role === "dietitian" || role === "admin";
}
