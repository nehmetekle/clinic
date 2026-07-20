import { settleVisitBasket } from "@/server/repositories/visitBaskets";
import { userIdByEmail } from "@/server/repositories/staff";
import { settleVisitBasketSchema } from "@/lib/validation";
import { actingUser, canHandleMoney } from "@/server/auth";
import { handleError, json, readJson } from "@/server/http";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Settling (recording the payment) is the secretary's action.
    if (!(await canHandleMoney(req))) return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    const input = await readJson(req, settleVisitBasketSchema);
    const actor = (await actingUser(req));
    return json(
      await settleVisitBasket(id, {
        ...input,
        actorName: actor.name,
        // Attribute the payment to the acting user so the money is traceable.
        createdById: await userIdByEmail(actor.email),
      }),
    );
  } catch (e) {
    return handleError(e);
  }
}
