import { db } from "@/server/db";
import { actingUser } from "@/server/auth";
import { verifyTotpCode, generateBackupCodes } from "@/server/totp";
import { writeAudit } from "@/server/repositories/audit";
import { confirmTwoFactorSchema } from "@/lib/validation";
import { json, readJson, handleError } from "@/server/http";

// Proves the admin actually scanned the QR code (entering a live code from
// their authenticator app) before 2FA becomes enforced at login. Also mints
// backup codes here — shown to the user exactly once in this response.
export async function POST(req: Request) {
  try {
    const actor = await actingUser(req);
    if (actor.role !== "admin" || !actor.id) return json({ error: "Not allowed" }, 403);

    const { code } = await readJson(req, confirmTwoFactorSchema);
    const user = await db.user.findUnique({ where: { id: actor.id } });
    if (!user?.totpSecret) return json({ error: "Start setup first" }, 400);

    const valid = await verifyTotpCode(user.totpSecret, code);
    if (!valid) return json({ error: "Invalid code" }, 401);

    const { plaintext, hashes } = generateBackupCodes();
    await db.user.update({
      where: { id: actor.id },
      data: { totpEnabled: true, totpBackupCodes: JSON.stringify(hashes) },
    });
    await writeAudit(db, {
      userId: actor.id,
      userName: actor.name,
      action: "Enabled two-factor authentication",
      entityType: "User",
      entityLabel: actor.name,
    });

    return json({ backupCodes: plaintext });
  } catch (e) {
    return handleError(e);
  }
}
