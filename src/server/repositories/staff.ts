import { Prisma } from "@prisma/client";
import { db } from "../db";
import { toStaff } from "../serialize";
import { hashPassword } from "../password";
import { revokeAllSessionsForUser } from "../session";
import { ConflictError, NotFoundError } from "../http";
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

/**
 * Admin edit of an existing staff member's details. Only the provided fields are
 * touched (a status-only toggle is just the `status` field). Email carries a
 * unique constraint, so a collision surfaces as a clean 409 rather than a 500.
 * Promoting someone to dietitian seeds the standard supplement list if they have
 * none yet, so their consultation screen has a usable set (mirrors createStaff).
 *
 * Guards the clinic against being left with no way in: an edit that would drop
 * the last active admin (by demotion or deactivation) is refused. The route
 * separately stops an admin editing their own role/status; this covers one admin
 * demoting another.
 */
export async function updateStaff(
  id: string,
  input: {
    fullName?: string;
    email?: string;
    phone?: string;
    role?: string;
    status?: string;
  },
): Promise<StaffUser> {
  const current = await db.user.findUnique({
    where: { id },
    select: { role: true, status: true, supplements: true },
  });
  if (!current) throw new NotFoundError("Staff member not found.");

  // Last-active-admin safeguard. Compute the effective role/status this edit
  // produces; if it turns an active admin into a non-active-admin and no other
  // active admin remains, block it.
  const effectiveRole = input.role ?? current.role;
  const effectiveStatus = input.status ?? current.status;
  const wasActiveAdmin = current.role === "admin" && current.status === "active";
  const willBeActiveAdmin = effectiveRole === "admin" && effectiveStatus === "active";
  if (wasActiveAdmin && !willBeActiveAdmin) {
    const otherActiveAdmins = await db.user.count({
      where: { id: { not: id }, role: "admin", status: "active" },
    });
    if (otherActiveAdmins === 0) {
      throw new ConflictError(
        "This is the only active admin — promote or activate another admin first.",
      );
    }
  }

  const data: Prisma.UserUpdateInput = {};
  if (input.fullName !== undefined) data.fullName = input.fullName;
  if (input.email !== undefined) data.email = input.email;
  if (input.phone !== undefined) data.phone = input.phone;
  if (input.status !== undefined) data.status = input.status;
  if (input.role !== undefined) {
    data.role = input.role;
    if (input.role === "dietitian") {
      const list = JSON.parse(current.supplements) as string[];
      if (list.length === 0) data.supplements = JSON.stringify([...SUPPLEMENTS]);
    }
  }

  try {
    const row = await db.user.update({ where: { id }, data });
    return toStaff(row);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new ConflictError("That email is already in use by another account.");
    }
    throw e;
  }
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
