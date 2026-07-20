import { updateVisitBasket } from "@/server/repositories/visitBaskets";
import { updateVisitBasketSchema } from "@/lib/validation";
import { actingUser, canHandleMoney } from "@/server/auth";
import { handleError, json, readJson } from "@/server/http";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Editing the basket (add/remove items, discount) is the secretary's action.
    if (!(await canHandleMoney(req))) return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    const input = await readJson(req, updateVisitBasketSchema);
    const actor = (await actingUser(req));
    return json(
      await updateVisitBasket(id, input, {
        name: actor.name,
        email: actor.email,
        role: actor.role,
      }),
    );
  } catch (e) {
    return handleError(e);
  }
}
