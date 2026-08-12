import { getJessyReport } from "@/server/repositories/jessy";
import { canManageJessy } from "@/server/auth";
import { handleError, json } from "@/server/http";

// The Jessy ledger: what patients paid through Jessy, what Jessy has transferred
// back, and what it still owes. These are aggregate financial figures, so the
// same admin-only rule that governs the reports page applies here
// (docs/01-product-spec.md §2.1) — not merely hidden in the nav.
export async function GET(req: Request) {
  try {
    if (!(await canManageJessy(req))) return json({ error: "Not allowed" }, 403);
    return json(await getJessyReport());
  } catch (e) {
    return handleError(e);
  }
}
