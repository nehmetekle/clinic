import { voidReferralCommission } from "@/server/repositories/referralCommissions";
import { actingUser, canManageReferrals } from "@/server/auth";
import { voidReferralCommissionSchema } from "@/lib/validation";
import { handleError, json, readJson } from "@/server/http";

// Writes off a commission the clinic will not pay. A reason is mandatory —
// forgiving an obligation is an accountability event, same rule as voiding a debt.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if (!(await canManageReferrals(req))) return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    const input = await readJson(req, voidReferralCommissionSchema);
    const actor = await actingUser(req);
    await voidReferralCommission(id, {
      reason: input.reason,
      actorName: actor.name,
      userId: actor.id,
    });
    return json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
