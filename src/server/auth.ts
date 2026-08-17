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

/** The schedule is the front desk's book: booking, rescheduling and cancelling
 * appointments belong to the secretary (and admin). A dietitian works the day
 * they're given — they never move a patient's slot. */
export async function canManageAppointments(req: Request): Promise<boolean> {
  const role = await actingRole(req);
  return role === "secretary" || role === "admin";
}

/** Writing off (voiding) a tracked debt forgives money the clinic is owed — an
 * accountability event reserved for the admin. The secretary can collect a debt
 * (records a real payment) but never write one off. */
export async function canVoidDebt(req: Request): Promise<boolean> {
  return (await actingRole(req)) === "admin";
}

/** The Jessy ledger (what the third-party payer owes the clinic, what it has
 * transferred) is a financial report, not a front-desk task: every figure on it
 * is an aggregate of income and outstanding balance. The permission matrix
 * (docs/01-product-spec.md §2.1) puts financial reports at admin-only — "the
 * secretary sees all clients but never financial reports" — so BOTH reading the
 * ledger and recording a transfer against it are admin-only.
 *
 * This is deliberately stricter than `canHandleMoney`: recording a Jessy
 * transfer is a back-office reconciliation against a reported balance, not
 * collecting money at the desk. It cannot be done meaningfully without seeing
 * the outstanding figure, which the secretary may not see. */
export async function canManageJessy(req: Request): Promise<boolean> {
  return (await actingRole(req)) === "admin";
}

/** The referral-commission ledger: what the clinic owes the people who send it
 * patients, and what it has paid them. Admin-only for the same reason as the
 * Jessy ledger — it is a financial report (docs/01-product-spec.md §2.1 reserves
 * those for the owner), and recording a payout means agreeing a balance the
 * secretary has no business seeing. Stricter than `canHandleMoney` on purpose. */
export async function canManageReferrals(req: Request): Promise<boolean> {
  return (await actingRole(req)) === "admin";
}

/** Logging a machine-only visit — a patient who came in just to use prepaid
 * machine sessions. It is the clinical side that decides a consultation isn't
 * needed today, so this is the doctor's call (and the admin's). It is NOT
 * `canViewClinical` reused: that gate is about READING clinical data, this one is
 * about recording attendance and consuming an already-purchased balance, and the
 * two are free to diverge later. The secretary is deliberately excluded: a
 * machine visit raises no charge at all, so there is nothing at the desk to do.
 * Selling the sessions in the first place is `canSellSessions`. */
export async function canLogMachineVisit(req: Request): Promise<boolean> {
  const role = await actingRole(req);
  return role === "dietitian" || role === "admin";
}

/** Selling or topping up treatment sessions outside a consultation. It raises an
 * ordinary basket for the patient to settle, so it is a front-desk money action —
 * the secretary's, and the admin's. The doctor's route to sell sessions is the
 * consultation that prescribes them. */
export async function canSellSessions(req: Request): Promise<boolean> {
  const role = await actingRole(req);
  return role === "secretary" || role === "admin";
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
