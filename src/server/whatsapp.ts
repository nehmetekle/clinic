// WhatsApp sending via Meta's Cloud API (graph.facebook.com).
// Config comes from env:
//   WHATSAPP_TOKEN            — access token (temporary in test, permanent in prod)
//   WHATSAPP_PHONE_NUMBER_ID  — the sending number's Phone Number ID
// Business-initiated messages (like reminders) MUST use a pre-approved template;
// free-form text only works inside a 24h window after the user messages us.
const GRAPH_VERSION = "v21.0";

export interface WhatsAppResult {
  ok: boolean;
  id?: string; // Meta message id on success
  error?: string; // human-readable error on failure
}

/** Strip a stored phone ("+961 76 119 365") down to the digits Meta wants ("96176119365"). */
export function toWhatsAppNumber(phone: string): string {
  return phone.replace(/\D/g, "");
}

function config(): { token: string; phoneNumberId: string } | null {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) return null;
  return { token, phoneNumberId };
}

/** True when WhatsApp is configured — lets callers no-op gracefully if it isn't. */
export function isWhatsAppConfigured(): boolean {
  return config() !== null;
}

/**
 * Send a pre-approved template message. `bodyParams` fill the template's {{1}},
 * {{2}}, … placeholders in order (e.g. patient name, appointment time).
 */
export async function sendWhatsAppTemplate(
  to: string,
  templateName: string,
  languageCode = "en_US",
  bodyParams: string[] = [],
): Promise<WhatsAppResult> {
  const cfg = config();
  if (!cfg) return { ok: false, error: "WhatsApp is not configured (missing WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID)." };

  const template: Record<string, unknown> = {
    name: templateName,
    language: { code: languageCode },
  };
  if (bodyParams.length) {
    template.components = [
      { type: "body", parameters: bodyParams.map((text) => ({ type: "text", text })) },
    ];
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${cfg.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: toWhatsAppNumber(to),
          type: "template",
          template,
        }),
      },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message ?? JSON.stringify(data);
      return { ok: false, error: `Meta API ${res.status}: ${msg}` };
    }
    return { ok: true, id: data?.messages?.[0]?.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Network error calling WhatsApp API" };
  }
}
