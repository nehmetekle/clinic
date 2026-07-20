import { updateStaffConsultationFee } from "@/server/repositories/staff";
import { updateStaffConsultationFeeSchema } from "@/lib/validation";
import { actingRole } from "@/server/auth";
import { handleError, json, readJson } from "@/server/http";

// Setting a dietitian's consultation fee is a pricing decision — admin only,
// same bar as the rest of the Pricing page. Every other role reads the fee (to
// render/settle the basket line) but can't change it.
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if ((await actingRole(req)) !== "admin") return json({ error: "Not allowed" }, 403);
    const { id } = await params;
    const { consultationFee } = await readJson(req, updateStaffConsultationFeeSchema);
    return json(await updateStaffConsultationFee(id, consultationFee));
  } catch (e) {
    return handleError(e);
  }
}
