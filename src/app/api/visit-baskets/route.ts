import { listVisitBaskets } from "@/server/repositories/visitBaskets";
import { actingRole } from "@/server/auth";
import { handleError, json } from "@/server/http";
import type { VisitBasketStatus } from "@/lib/types";

export async function GET(req: Request) {
  try {
    // Both the dietitian and the secretary see the queue's payment column.
    if (!(await actingRole(req))) return json([]);
    const params = new URL(req.url).searchParams;
    const status = (params.get("status") as VisitBasketStatus | null) ?? undefined;
    const clientId = params.get("clientId") ?? undefined;
    return json(await listVisitBaskets({ status, clientId }));
  } catch (e) {
    return handleError(e);
  }
}
