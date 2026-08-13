import { voidMachineVisit } from "@/server/repositories/machineVisits";
import { voidMachineVisitSchema } from "@/lib/validation";
import { actingUser, canLogMachineVisit } from "@/server/auth";
import { handleError, json, readJson } from "@/server/http";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if (!(await canLogMachineVisit(req))) return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    const input = await readJson(req, voidMachineVisitSchema);
    const actor = await actingUser(req);
    return json(await voidMachineVisit(id, input, actor));
  } catch (e) {
    return handleError(e);
  }
}
