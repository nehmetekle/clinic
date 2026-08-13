import { listFxRateChanges } from "@/server/repositories/settings";
import { actingRole } from "@/server/auth";
import { handleError, json } from "@/server/http";

/**
 * The append-only exchange-rate change history.
 *
 * Admin-only, matching who may CHANGE a rate: it names staff members and is a
 * financial audit trail, which docs/01-product-spec.md §2.1 reserves for the
 * admin. Read-only by design — there is deliberately no POST/PATCH/DELETE here or
 * anywhere else, so history cannot be edited through the API at all.
 */
export async function GET(req: Request) {
  try {
    if ((await actingRole(req)) !== "admin") return json({ error: "Not allowed" }, 403);
    return json(await listFxRateChanges());
  } catch (e) {
    return handleError(e);
  }
}
