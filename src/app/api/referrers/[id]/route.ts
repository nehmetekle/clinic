import { deleteReferrer, updateReferrer } from "@/server/repositories/referrers";
import { updateReferrerSchema } from "@/lib/validation";
import { actingRole } from "@/server/auth";
import { handleError, json, readJson } from "@/server/http";

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if ((await actingRole(req)) !== "admin") return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    const input = await readJson(req, updateReferrerSchema);
    return json(await updateReferrer(id, input));
  } catch (e) {
    return handleError(e);
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if ((await actingRole(req)) !== "admin") return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    await deleteReferrer(id);
    return json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
