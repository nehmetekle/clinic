import { listExpenseAudit } from "@/server/repositories/expenses";
import { actingRole } from "@/server/auth";
import { ForbiddenError, handleError, json } from "@/server/http";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if ((await actingRole(req)) !== "admin") throw new ForbiddenError("Only admins can view expense logs");
    const { id } = await params;
    return json(await listExpenseAudit(id));
  } catch (e) {
    return handleError(e);
  }
}
