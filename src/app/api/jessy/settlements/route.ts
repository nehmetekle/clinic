import { recordJessySettlement } from "@/server/repositories/jessy";
import { userIdByEmail } from "@/server/repositories/staff";
import { recordJessySettlementSchema } from "@/lib/validation";
import { actingUser, canManageJessy } from "@/server/auth";
import { handleError, json, readJson } from "@/server/http";

// Records money actually received from Jessy. This COLLECTS an existing
// receivable — it deliberately creates no Payment and no income, because that
// income was already recognized when the patient paid through Jessy.
// Admin-only, matching the ledger it draws down (see canManageJessy): the
// outstanding balance it works against is a financial report figure the
// secretary may not see. Over-settlement is refused in the repository, inside
// the settlement transaction.
export async function POST(req: Request) {
  try {
    if (!(await canManageJessy(req))) return json({ error: "Not allowed" }, 403);
    const input = await readJson(req, recordJessySettlementSchema);
    const actor = await actingUser(req);
    // Attribute the settlement to a real user so the transfer is traceable.
    const recordedById = await userIdByEmail(actor.email);
    return json(
      await recordJessySettlement({ ...input, recordedById, recordedByName: actor.name }),
      201,
    );
  } catch (e) {
    return handleError(e);
  }
}
