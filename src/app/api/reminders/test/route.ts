import { z } from "zod";
import { actingRole } from "@/server/auth";
import { sendWhatsAppTemplate } from "@/server/whatsapp";
import { json, readJson, handleError } from "@/server/http";

// Admin-only "send me a test reminder" — fires the reminder template at a given
// number on demand, so staff can confirm WhatsApp works without waiting for a
// real appointment window. During testing the number must be a verified Meta
// test recipient; in production it works for any patient.
const testSchema = z.object({ phone: z.string().min(1, "Phone is required") });

export async function POST(req: Request) {
  try {
    if ((await actingRole(req)) !== "admin") return json({ error: "Not allowed" }, 403);
    const { phone } = await readJson(req, testSchema);
    const template = process.env.WHATSAPP_TEMPLATE_24H || "hello_world";
    const lang = process.env.WHATSAPP_TEMPLATE_LANG || "en_US";
    const r = await sendWhatsAppTemplate(phone, template, lang);
    if (!r.ok) return json({ error: r.error }, 502);
    return json({ ok: true, id: r.id });
  } catch (e) {
    return handleError(e);
  }
}
