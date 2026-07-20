import { db } from "@/server/db";
import { actingUser } from "@/server/auth";
import { generateTotpSecret, buildQrCodeDataUrl } from "@/server/totp";
import { json, handleError } from "@/server/http";

// Two-factor auth is admin-only for now (docs/01-product-spec.md §3.1).
// Generates a secret and stores it (unconfirmed — totpEnabled stays false
// until POST /api/auth/2fa/confirm proves the user actually scanned it).
export async function POST(req: Request) {
  try {
    const actor = await actingUser(req);
    if (actor.role !== "admin" || !actor.id) return json({ error: "Not allowed" }, 403);

    const secret = generateTotpSecret();
    await db.user.update({ where: { id: actor.id }, data: { totpSecret: secret, totpEnabled: false } });
    const qrCodeDataUrl = await buildQrCodeDataUrl(actor.email ?? actor.name, secret);

    return json({ secret, qrCodeDataUrl });
  } catch (e) {
    return handleError(e);
  }
}
