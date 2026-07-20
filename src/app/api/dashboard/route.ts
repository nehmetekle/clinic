import { getDashboardSummaryForRole } from "@/server/services/dashboard";
import { actingRole, canViewClinical } from "@/server/auth";
import { handleError, json } from "@/server/http";

export async function GET(req: Request) {
  try {
    // The dashboard aggregates clinic figures — require a signed-in role, reject
    // unknown callers. The service itself redacts financial-report figures for
    // non-admin roles (server-side, not just left to each role's UI to omit).
    const role = await actingRole(req);
    if (!role) return json({ error: "Not allowed" }, 403);
    // Optional period window for the flow figures (income/expenses/net profit).
    const url = new URL(req.url);
    const from = url.searchParams.get("from") ?? undefined;
    const to = url.searchParams.get("to") ?? undefined;
    return json(
      await getDashboardSummaryForRole({
        role,
        includeMedicalHistoryStatus: (await canViewClinical(req)),
        from,
        to,
      }),
    );
  } catch (e) {
    return handleError(e);
  }
}
