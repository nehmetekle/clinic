import { recordReferralPayout } from "@/server/repositories/referralCommissions";
import { actingUser, canManageReferrals } from "@/server/auth";
import { recordReferralPayoutSchema } from "@/lib/validation";
import { handleError, json, readJson } from "@/server/http";

// Records money actually PAID to a referrer against specific incurred commissions.
// This writes no Expense and no Payment: the expense was recognized when each
// commission was incurred, so recognizing it again here would double-count it.
export async function POST(req: Request) {
  try {
    if (!(await canManageReferrals(req))) return json({ error: "Not allowed" }, 403);
    const input = await readJson(req, recordReferralPayoutSchema);
    const actor = await actingUser(req);
    return json(
      await recordReferralPayout({
        ...input,
        recordedById: actor.id,
        recordedByName: actor.name,
      }),
    );
  } catch (e) {
    return handleError(e);
  }
}
