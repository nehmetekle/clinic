import { db } from "@/server/db";
import { resetStaffPassword } from "@/server/repositories/staff";
import { resetStaffPasswordSchema } from "@/lib/validation";
import { actingRole, actingUser } from "@/server/auth";
import { writeAudit } from "@/server/repositories/audit";
import { handleError, json, readJson } from "@/server/http";

// Admin-initiated password reset — no email/reset-link flow yet (see
// docs/known-issues.md). Sets a new password directly and revokes the
// target's existing sessions.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if ((await actingRole(req)) !== "admin") return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    const { password } = await readJson(req, resetStaffPasswordSchema);
    const staff = await resetStaffPassword(id, password);

    const actor = await actingUser(req);
    await writeAudit(db, {
      userId: actor.id,
      userName: actor.name,
      action: "Reset staff password",
      entityType: "User",
      entityLabel: staff.fullName,
    });

    return json(staff);
  } catch (e) {
    return handleError(e);
  }
}
