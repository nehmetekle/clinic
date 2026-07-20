import { listOutstandingDebts } from "@/server/repositories/clientDebts";
import { canHandleMoney } from "@/server/auth";
import { handleError, json } from "@/server/http";

// All outstanding client debts — the single source of truth for money owed.
// Handling money is the secretary's (and admin's) domain.
export async function GET(req: Request) {
  try {
    if (!(await canHandleMoney(req))) return json({ error: "Not allowed" }, 403);
    return json(await listOutstandingDebts());
  } catch (e) {
    return handleError(e);
  }
}
