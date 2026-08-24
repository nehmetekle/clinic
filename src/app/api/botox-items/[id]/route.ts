import { deleteBotoxItem, updateBotoxItem } from "@/server/repositories/botoxItems";
import { updateBotoxItemSchema } from "@/lib/validation";
import { actingRole } from "@/server/auth";
import { handleError, json, readJson } from "@/server/http";

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Only the admin can change a Botox item (including its price).
    if ((await actingRole(req)) !== "admin") return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    const input = await readJson(req, updateBotoxItemSchema);
    return json(await updateBotoxItem(id, input));
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
    await deleteBotoxItem(id);
    return json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
