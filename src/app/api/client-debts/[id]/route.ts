import { clearClientDebt, voidClientDebt } from "@/server/repositories/clientDebts";
import { userIdByEmail } from "@/server/repositories/staff";
import { updateClientDebtSchema } from "@/lib/validation";
import { actingUser, canHandleMoney, canVoidDebt } from "@/server/auth";
import { handleError, json, readJson } from "@/server/http";

// Clear (collect — records a Payment) or void (write off) a tracked client debt.
// Collecting is the secretary's (and admin's) domain; voiding (writing money off)
// is an accountability event reserved for the admin.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if (!(await canHandleMoney(req))) return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    const input = await readJson(req, updateClientDebtSchema);
    // Writing off a debt is admin-only — a secretary can collect but never forgive.
    if (input.action === "void" && !(await canVoidDebt(req))) {
      return json({ error: "Only an admin can void a debt" }, 403);
    }
    const actor = (await actingUser(req));
    // Resolve the acting user once — used to attribute the settlement payment and
    // to link the audit-log entry to a real user.
    const userId = await userIdByEmail(actor.email);
    if (input.action === "clear") {
      return json(
        await clearClientDebt(id, {
          method: input.method!,
          notes: input.notes,
          clearedByName: actor.name,
          // Attribute the settlement payment to the acting user (traceability).
          createdById: userId,
        }),
      );
    }
    return json(
      await voidClientDebt(id, { reason: input.reason!, clearedByName: actor.name, userId }),
    );
  } catch (e) {
    return handleError(e);
  }
}
