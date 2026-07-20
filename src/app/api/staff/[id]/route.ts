import { z } from "zod";
import { updateStaffStatus } from "@/server/repositories/staff";
import { actingRole } from "@/server/auth";
import { handleError, json, readJson } from "@/server/http";

const patchSchema = z.object({ status: z.enum(["active", "inactive"]) });

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Activating/deactivating staff is owner territory — admin only.
    if ((await actingRole(req)) !== "admin") return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    const { status } = await readJson(req, patchSchema);
    return json(await updateStaffStatus(id, status));
  } catch (e) {
    return handleError(e);
  }
}
