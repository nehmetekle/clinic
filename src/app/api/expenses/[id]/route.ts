import { updateExpense } from "@/server/repositories/expenses";
import { updateExpenseSchema } from "@/lib/validation";
import { actingUser, canHandleMoney } from "@/server/auth";
import { handleError, json, readJson } from "@/server/http";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Expenses are money records — the secretary/admin only, same as payments.
    if (!(await canHandleMoney(req))) return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    const input = await readJson(req, updateExpenseSchema);
    return json(await updateExpense(id, input, (await actingUser(req))));
  } catch (e) {
    return handleError(e);
  }
}
