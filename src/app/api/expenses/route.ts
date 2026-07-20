import { createExpense, listExpenses } from "@/server/repositories/expenses";
import { createExpenseSchema } from "@/lib/validation";
import { handleError, json, readJson } from "@/server/http";
import { actingUser, canHandleMoney } from "@/server/auth";

export async function GET(req: Request) {
  try {
    // Expenses are money records — the secretary/admin only, same as payments.
    if (!(await canHandleMoney(req))) return json([]);
    return json(await listExpenses());
  } catch (e) {
    return handleError(e);
  }
}

export async function POST(req: Request) {
  try {
    if (!(await canHandleMoney(req))) return json({ error: "Not allowed" }, 403);
    const input = await readJson(req, createExpenseSchema);
    return json(await createExpense(input, (await actingUser(req))), 201);
  } catch (e) {
    return handleError(e);
  }
}
