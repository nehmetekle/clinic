import { updateServicePrice } from "@/server/repositories/service-prices";
import { updateServicePriceSchema } from "@/lib/validation";
import { actingRole } from "@/server/auth";
import { handleError, json, readJson } from "@/server/http";

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Only admins can change service prices; consultation users can only read them.
    if ((await actingRole(req)) !== "admin") return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    const input = await readJson(req, updateServicePriceSchema);
    return json(await updateServicePrice(id, input));
  } catch (e) {
    return handleError(e);
  }
}
