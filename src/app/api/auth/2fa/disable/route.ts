import { db } from "@/server/db";
import { actingUser } from "@/server/auth";
import { verifyPassword } from "@/server/password";
import { writeAudit } from "@/server/repositories/audit";
import { disableTwoFactorSchema } from "@/lib/validation";
import { json, readJson, handleError } from "@/server/http";

// Requires the current password (not just an active session) — disabling 2FA
// is a sensitive action, and a session alone could be a stolen/left-open one.
export async function POST(req: Request) {
  try {
    const actor = await actingUser(req);
    if (actor.role !== "admin" || !actor.id) return json({ error: "Not allowed" }, 403);

    const { password } = await readJson(req, disableTwoFactorSchema);
    const user = await db.user.findUnique({ where: { id: actor.id } });
    if (!user) return json({ error: "Not allowed" }, 403);

    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) return json({ error: "Incorrect password" }, 401);

    await db.user.update({
      where: { id: actor.id },
      data: { totpEnabled: false, totpSecret: null, totpBackupCodes: "[]" },
    });
    await writeAudit(db, {
      userId: actor.id,
      userName: actor.name,
      action: "Disabled two-factor authentication",
      entityType: "User",
      entityLabel: actor.name,
    });

    return json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
