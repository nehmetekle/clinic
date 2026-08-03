import { json } from "@/server/http";

// ONE-TIME admin endpoint: creates the `appointment_reminder` WhatsApp template
// on the account, using the server's (valid, permanent) WHATSAPP_TOKEN. Guarded
// by CRON_SECRET like the cron route. Safe to re-run — Meta rejects a duplicate
// name with a clear error. Remove this route once the template exists.
const GRAPH = "https://graph.facebook.com/v21.0";

const TEMPLATE = {
  name: "appointment_reminder",
  language: "en_US",
  category: "UTILITY",
  components: [
    {
      type: "BODY",
      text: "Hi {{1}}, reminder: your appointment at Layaka is on {{2}} at {{3}}. See you soon!",
      example: { body_text: [["Nehme", "Aug 3, 2026", "9:00 AM"]] },
    },
  ],
};

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) return json({ error: "Unauthorized" }, 401);
  }

  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    return json({ error: "Missing WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID" }, 500);
  }

  // 1. Resolve the parent WhatsApp Business Account (templates live on the WABA,
  //    not the phone number). Allow ?waba=<id> to override discovery.
  const url = new URL(req.url);
  let wabaId = url.searchParams.get("waba") ?? undefined;
  let discovery: unknown = null;
  if (!wabaId) {
    const r = await fetch(
      `${GRAPH}/${phoneNumberId}?fields=whatsapp_business_account&access_token=${token}`,
    );
    discovery = await r.json().catch(() => ({}));
    const d = discovery as { whatsapp_business_account?: { id?: string }; error?: unknown };
    if (!r.ok || !d.whatsapp_business_account?.id) {
      return json({ step: "discover-waba", ok: false, discovery }, 502);
    }
    wabaId = d.whatsapp_business_account.id;
  }

  // 2. Create the template on the WABA.
  const create = await fetch(`${GRAPH}/${wabaId}/message_templates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(TEMPLATE),
  });
  const result = await create.json().catch(() => ({}));
  return json({ step: "create-template", ok: create.ok, wabaId, result }, create.ok ? 200 : 502);
}
