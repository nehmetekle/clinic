import { getReferralReport } from "@/server/repositories/referralCommissions";
import { canManageReferrals } from "@/server/auth";
import { handleError, json } from "@/server/http";

// The referral-commission ledger: what the clinic owes each referrer, what it has
// paid, and what is still outstanding. Aggregate financial figures, so the same
// admin-only rule that governs the reports page and the Jessy ledger applies
// (docs/01-product-spec.md §2.1) — enforced here, not merely hidden in the nav.
export async function GET(req: Request) {
  try {
    if (!(await canManageReferrals(req))) return json({ error: "Not allowed" }, 403);
    return json(await getReferralReport());
  } catch (e) {
    return handleError(e);
  }
}
