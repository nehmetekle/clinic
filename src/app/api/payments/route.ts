import { createPayment, listPayments } from "@/server/repositories/payments";
import { userIdByEmail } from "@/server/repositories/staff";
import { createPaymentSchema } from "@/lib/validation";
import { actingUser, canHandleMoney } from "@/server/auth";
import { handleError, json, readJson } from "@/server/http";

export async function GET(req: Request) {
  try {
    // Payments are money records — the secretary/admin only (not the dietitian).
    if (!(await canHandleMoney(req))) return json([]);
    // Optional clinic-day filter (YYYY-MM-DD); omitted → every payment.
    const date = new URL(req.url).searchParams.get("date") ?? undefined;
    return json(await listPayments(date));
  } catch (e) {
    return handleError(e);
  }
}

export async function POST(req: Request) {
  try {
    if (!(await canHandleMoney(req))) return json({ error: "Not allowed" }, 403);
    const input = await readJson(req, createPaymentSchema);
    // Attribute the collection to the acting user so the money is traceable.
    const actor = (await actingUser(req));
    const createdById = await userIdByEmail(actor.email);
    // `input.idempotencyKey` flows through so a double-submit can't duplicate income (R2).
    return json(await createPayment({ ...input, createdById, actorName: actor.name }), 201);
  } catch (e) {
    return handleError(e);
  }
}
