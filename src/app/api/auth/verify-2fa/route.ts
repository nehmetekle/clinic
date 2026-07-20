import { db } from "@/server/db";
import { verifyTotpCode, consumeBackupCode } from "@/server/totp";
import {
  resolvePendingTwoFactor,
  recordFailedTwoFactorAttempt,
  deletePendingTwoFactor,
  createSession,
  attachSessionCookie,
} from "@/server/session";
import { writeAudit } from "@/server/repositories/audit";
import { verifyTwoFactorSchema } from "@/lib/validation";
import { json, readJson, handleError } from "@/server/http";

// Step 2 of login for a user with totpEnabled: exchanges a pending-2FA token
// (from step 1's password check) plus a TOTP/backup code for a real session.
export async function POST(req: Request) {
  try {
    const { pendingToken, code } = await readJson(req, verifyTwoFactorSchema);
    const pending = await resolvePendingTwoFactor(pendingToken);
    if (!pending) return json({ error: "Session expired, please log in again." }, 401);

    const user = await db.user.findUnique({ where: { id: pending.userId } });
    if (!user) return json({ error: "Session expired, please log in again." }, 401);

    const isTotpValid = user.totpSecret ? await verifyTotpCode(user.totpSecret, code) : false;
    let remainingBackupHashes: string[] | null = null;
    if (!isTotpValid) {
      remainingBackupHashes = consumeBackupCode(JSON.parse(user.totpBackupCodes), code);
    }

    if (!isTotpValid && !remainingBackupHashes) {
      await recordFailedTwoFactorAttempt(pending.id);
      return json({ error: "Invalid code" }, 401);
    }

    if (remainingBackupHashes) {
      await db.user.update({
        where: { id: user.id },
        data: { totpBackupCodes: JSON.stringify(remainingBackupHashes) },
      });
    }

    await deletePendingTwoFactor(pending.id);
    await db.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    const token = await createSession(user.id, {
      userAgent: req.headers.get("user-agent"),
      ip: req.headers.get("x-forwarded-for"),
    });
    await writeAudit(db, {
      userId: user.id,
      userName: user.fullName,
      action: remainingBackupHashes ? "Logged in (2FA backup code)" : "Logged in (2FA)",
      entityType: "User",
      entityLabel: user.fullName,
    });

    const res = json({
      user: {
        id: user.id,
        name: user.fullName,
        role: user.role,
        email: user.email,
        totpEnabled: user.totpEnabled,
      },
    });
    attachSessionCookie(res, token);
    return res;
  } catch (e) {
    return handleError(e);
  }
}
