import { getClientDetail, updateClient } from "@/server/repositories/clients";
import { updateClientSchema } from "@/lib/validation";
import { actingRole, canViewClinical } from "@/server/auth";
import { handleError, json, readJson } from "@/server/http";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const role = await actingRole(req);
    if (!role) return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    const detail = await getClientDetail(id, await canViewClinical(req), role);
    if (!detail) return json({ error: "Client not found" }, 404);
    return json(detail);
  } catch (e) {
    return handleError(e);
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Editing a patient record (check-in, profile updates) needs a signed-in
    // role — reject unknown callers, same as client creation. Once intake is
    // complete, the repository further restricts each field to the role that
    // owns it (front desk for demographics, dietitian for clinical notes).
    const role = (await actingRole(req));
    if (!role) return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    const input = await readJson(req, updateClientSchema);
    return json(await updateClient(id, input, role));
  } catch (e) {
    return handleError(e);
  }
}
