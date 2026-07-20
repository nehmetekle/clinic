import { db } from "../db";
import { toStaff } from "../serialize";
import { hashPassword } from "../password";
import { revokeAllSessionsForUser } from "../session";
import { SUPPLEMENTS } from "@/lib/types";
import type { StaffUser } from "@/lib/types";

/**
 * Resolves the acting user (identified by the email from the demo-auth headers)
 * to a real User row, so money records can be attributed to a person. Returns
 * null when the header is missing or matches no user — V3's real sessions will
 * make this authoritative.
 */
export async function userIdByEmail(email: string | undefined): Promise<string | null> {
  if (!email) return null;
  const user = await db.user.findUnique({ where: { email }, select: { id: true } });
  return user?.id ?? null;
}

export async function listStaff(): Promise<StaffUser[]> {
  const rows = await db.user.findMany({ orderBy: { createdAt: "asc" } });
  return rows.map(toStaff);
}

export async function updateStaffStatus(
  id: string,
  status: string,
): Promise<StaffUser> {
  const row = await db.user.update({ where: { id }, data: { status } });
  return toStaff(row);
}

export async function createStaff(input: {
  fullName: string;
  email: string;
  phone?: string;
  role: string;
  status?: string;
  password: string;
}): Promise<StaffUser> {
  // New dietitians start with the current standard supplement list so they have
  // a usable set to trim/extend from; other roles don't use the field.
  const supplements =
    input.role === "dietitian" ? JSON.stringify([...SUPPLEMENTS]) : "[]";
  const passwordHash = await hashPassword(input.password);
  const row = await db.user.create({
    data: {
      fullName: input.fullName,
      email: input.email,
      phone: input.phone,
      role: input.role,
      status: input.status ?? "active",
      supplements,
      passwordHash,
    },
  });
  return toStaff(row);
}

/**
 * Admin-initiated reset: sets a new password for an existing staff member (no
 * email/reset-link flow yet — see docs/known-issues.md). Revokes every active
 * session for that user so a compromised or forgotten-but-still-logged-in
 * session can't outlive the reset.
 */
export async function resetStaffPassword(id: string, password: string): Promise<StaffUser> {
  const passwordHash = await hashPassword(password);
  const row = await db.user.update({
    where: { id },
    data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null },
  });
  await revokeAllSessionsForUser(id);
  return toStaff(row);
}

/** Replaces a dietitian's personal recommended-supplement list. Trims and
 * de-duplicates (case-insensitive) while preserving the given order. */
export async function updateStaffSupplements(
  id: string,
  supplements: string[],
): Promise<StaffUser> {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const raw of supplements) {
    const value = raw.trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    cleaned.push(value);
  }
  const row = await db.user.update({
    where: { id },
    data: { supplements: JSON.stringify(cleaned) },
  });
  return toStaff(row);
}

/**
 * Admin sets a dietitian's consultation fee (USD). Stored on the user account so
 * it ties to a real staff member, not a typed name. A fee of 0 (or less) clears
 * it (stored as null) — no line is auto-added. Changing it here never rewrites
 * fees already frozen onto past consultations.
 */
export async function updateStaffConsultationFee(
  id: string,
  consultationFee: number,
): Promise<StaffUser> {
  const row = await db.user.update({
    where: { id },
    data: { consultationFee: consultationFee > 0 ? consultationFee : null },
  });
  return toStaff(row);
}
