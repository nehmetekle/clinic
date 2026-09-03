import { listExternalLabOrdersForClient } from "@/server/repositories/externalLabOrders";
import { actingRole } from "@/server/auth";
import { handleError, json } from "@/server/http";

/**
 * A client's external-lab order history — date and test names only. Mirrors
 * `/api/blood-samples`: lab logistics are visible to any signed-in staff
 * member, and there is nothing price-related in this response to gate —
 * `listExternalLabOrdersForClient` never selects the cost or sale price, so
 * this route needs no `canViewExternalLabCost` check the way the
 * per-consultation order route does.
 */
export async function GET(req: Request) {
  try {
    if (!(await actingRole(req))) return json([]);
    const clientId = new URL(req.url).searchParams.get("clientId");
    if (!clientId) return json([]);
    return json(await listExternalLabOrdersForClient(clientId));
  } catch (e) {
    return handleError(e);
  }
}
