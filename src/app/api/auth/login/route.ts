import { db } from "@/server/db";
import { verifyPassword, getDummyHash } from "@/server/password";
import {
  createSession,
  attachSessionCookie,
  createPendingTwoFactor,
  MAX_FAILED_LOGIN_ATTEMPTS,
  LOCKOUT_DURATION_MS,
} from "@/server/session";
import { writeAudit } from "@/server/repositories/audit";
import { loginSchema } from "@/lib/validation";
import { json, readJson, handleError } from "@/server/http";

const INVALID_CREDENTIALS = { error: "Invalid email or password" };

export async function POST(req: Request) {
  try {
    const { email, password } = await readJson(req, loginSchema);
    const user = await db.user.findUnique({ where: { email } });

    // Locked accounts are rejected before the password is even checked, so
    // hammering the endpoint can't extend the lockout indefinitely.
    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      return json({ error: "Too many failed attempts. Try again in a few minutes." }, 423);
    }

    // Verify against the dummy hash for an unknown email so response timing
    // never reveals whether the account exists.
    const ok = await verifyPassword(user?.passwordHash || (await getDummyHash()), password);

    if (!user || !ok) {
      if (user) {
        const attempts = user.failedLoginAttempts + 1;
        await db.user.update({
          where: { id: user.id },
          data: {
            failedLoginAttempts: attempts,
            lockedUntil:
              attempts >= MAX_FAILED_LOGIN_ATTEMPTS ? new Date(Date.now() + LOCKOUT_DURATION_MS) : null,
          },
        });
        await writeAudit(db, {
          userId: user.id,
          userName: user.fullName,
          action: "Failed login attempt",
          entityType: "User",
          entityLabel: user.fullName,
        });
      }
      return json(INVALID_CREDENTIALS, 401);
    }

    // Deactivated staff can't log in even with the right password — same
    // generic message as a wrong password, so it doesn't confirm the account.
    if (user.status !== "active") return json(INVALID_CREDENTIALS, 401);

    await db.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });

    // Password is correct, but a 2FA-enrolled account needs a second step
    // before a real session is issued — no cookie is set on this response.
    if (user.totpEnabled) {
      const pendingToken = await createPendingTwoFactor(user.id);
      return json({ requires2FA: true, pendingToken });
    }

    await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    const token = await createSession(user.id, {
      userAgent: req.headers.get("user-agent"),
      ip: req.headers.get("x-forwarded-for"),
    });
    await writeAudit(db, {
      userId: user.id,
      userName: user.fullName,
      action: "Logged in",
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
