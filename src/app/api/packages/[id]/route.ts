import { updatePackage } from "@/server/repositories/packages";
import { updatePackageSchema } from "@/lib/validation";
import { actingRole } from "@/server/auth";
import { handleError, json, readJson } from "@/server/http";

// Handles both the list's status toggle ({ status }) and full package edits
// (name/price/cost/… ) — every field in updatePackageSchema is optional.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Only the admin edits packages, their price and cost.
    if ((await actingRole(req)) !== "admin") return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    const input = await readJson(req, updatePackageSchema);
    return json(await updatePackage(id, input));
  } catch (e) {
    return handleError(e);
  }
}
