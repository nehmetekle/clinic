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
    // A blank bound is NOT an open-ended one. An empty `from=` used to fall
    // through as "no lower bound", so clearing one date box in a custom range
    // silently turned a month's report into an all-time report — with the header
    // still naming the month. Reject the half-specified window instead.
    const rawFrom = url.searchParams.get("from");
    const rawTo = url.searchParams.get("to");
    const from = rawFrom?.trim() || undefined;
    const to = rawTo?.trim() || undefined;
    if ((rawFrom !== null && !from) || (rawTo !== null && !to)) {
      return json({ error: "Both a start and an end date are required." }, 400);
    }
    // Downstream (getDashboardSummaryForRole) compares these as plain ISO
    // strings (`date >= opts.from`), so a malformed value here doesn't error —
    // it silently mis-filters. Enforce the YYYY-MM-DD shape at the boundary.
    const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
    if ((from && !ISO_DATE.test(from)) || (to && !ISO_DATE.test(to))) {
      return json({ error: "Dates must be in YYYY-MM-DD format." }, 400);
    }
    if (from && to && from > to) {
      return json({ error: "The start date must not be after the end date." }, 400);
    }
    // Scopes the earned figures to one dietitian. Never the clinic-wide costs.
    const dietitianId = url.searchParams.get("dietitianId")?.trim() || undefined;
    return json(
      await getDashboardSummaryForRole({
        role,
        includeMedicalHistoryStatus: (await canViewClinical(req)),
        from,
        to,
        dietitianId,
      }),
    );
  } catch (e) {
    return handleError(e);
  }
}
