import { findClientsByPhone } from "@/server/repositories/clients";
import { actingRole, canViewClinical } from "@/server/auth";
import { handleError, json } from "@/server/http";

// Exact normalized-phone lookup powering the duplicate-patient warning shown at
// registration and phone booking. Mirrors the clinical-field filtering of the
// client list so the front desk never sees medical notes here either.
export async function GET(req: Request) {
  try {
    if (!(await actingRole(req))) return json({ error: "Not allowed" }, 403);
    const phone = new URL(req.url).searchParams.get("phone") ?? "";
    return json(await findClientsByPhone(phone, (await canViewClinical(req))));
  } catch (e) {
    return handleError(e);
  }
}
