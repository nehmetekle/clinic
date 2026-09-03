import { actingUser, canPriceExternalLabSale, canViewExternalLabCost } from "@/server/auth";
import { externalLabSalePriceSchema } from "@/lib/validation";
import {
  getExternalLabOrder,
  setExternalLabSalePrice,
} from "@/server/repositories/externalLabOrders";
import { handleError, json, readJson } from "@/server/http";

/**
 * The external-lab order, and the ONE edit the front desk is allowed to make.
 *
 * This route exists separately from /api/consultations/[id] because the two have
 * different audiences. That route is clinical (`canViewClinical` — doctor and
 * admin only, a secretary gets nothing). This one is reachable by the secretary,
 * who has to see and correct what the patient is being charged, and must never
 * receive what the lab charges the clinic.
 *
 * The cost is not hidden from the secretary's screen — it is absent from the
 * secretary's response body (`canSeeCost: false` in the serializer), so there is
 * nothing in the browser to reveal.
 */

// Read the order. Every role that can settle or record one may read it; only
// dietitian/admin get the cost fields in the payload.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!(await canPriceExternalLabSale(req))) return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    const canSeeCost = await canViewExternalLabCost(req);
    return json(await getExternalLabOrder(id, { canSeeCost }));
  } catch (e) {
    return handleError(e);
  }
}

// Reprice the patient-facing total. The cost, the notes and the test list are
// unreachable from here by construction (see externalLabSalePriceSchema) — those
// are edited through the consultation editor, which is doctor/admin only.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!(await canPriceExternalLabSale(req))) return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    const input = await readJson(req, externalLabSalePriceSchema);
    const actor = await actingUser(req);
    const updated = await setExternalLabSalePrice(id, input, actor, {
      canSeeCost: await canViewExternalLabCost(req),
    });
    return json(updated);
  } catch (e) {
    return handleError(e);
  }
}

// Deliberately no POST/DELETE: creating or removing an external-lab order is a
// clinical act that happens in the consultation editor, under
// `canOrderExternalLab`. Adding one here would give the front desk a way to
// invent or erase a charge outside the visit record.
