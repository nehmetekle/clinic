import { createSessionPlan } from "@/server/repositories/sessionPlans";
import { createSessionPlanSchema } from "@/lib/validation";
import { canViewClinical } from "@/server/auth";
import { handleError, json, readJson } from "@/server/http";

export async function POST(req: Request) {
  try {
    if (!(await canViewClinical(req))) return json({ error: "Not allowed" }, 403);
    const input = await readJson(req, createSessionPlanSchema);
    return json(await createSessionPlan(input), 201);
  } catch (e) {
    return handleError(e);
  }
}
