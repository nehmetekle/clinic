import { listBloodSamples } from "@/server/repositories/bloodSamples";
import { actingRole } from "@/server/auth";
import { handleError, json } from "@/server/http";

export async function GET(req: Request) {
  try {
    // Lab logistics are visible to any signed-in staff member.
    if (!(await actingRole(req))) return json([]);
    const clientId = new URL(req.url).searchParams.get("clientId") ?? undefined;
    return json(await listBloodSamples({ clientId }));
  } catch (e) {
    return handleError(e);
  }
}
