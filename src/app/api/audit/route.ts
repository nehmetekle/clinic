import { listAudit } from "@/server/repositories/audit";
import { actingRole } from "@/server/auth";
import { ForbiddenError, handleError, json } from "@/server/http";

export async function GET(req: Request) {
  try {
    if ((await actingRole(req)) !== "admin") throw new ForbiddenError("Only admins can view audit logs");
    return json(await listAudit());
  } catch (e) {
    return handleError(e);
  }
}
