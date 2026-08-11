import { digitsOnly, isValidInternationalPhone } from "@/lib/phone";

/**
 * Building "open a WhatsApp chat with this patient" links.
 *
 * **WhatsApp cannot be made to attach a file from a web page.** Neither `wa.me`
 * nor any other WhatsApp entry point takes a file/attachment parameter — it's a
 * platform restriction, not a gap in this app, and there is no workaround. So
 * the most a link can do is open the right conversation with the number (and
 * optionally some text) already filled in; whoever is sending still attaches the
 * downloaded PDF by hand. Every caller's UI copy must say so rather than imply
 * the file travels with the link.
 *
 * `wa.me` is WhatsApp's own canonical link format and is the one to use:
 * `web.whatsapp.com/send` is desktop-only and breaks on a phone, and the
 * `whatsapp://` scheme dead-ends when the desktop app isn't installed. `wa.me`
 * lets the sender's own machine pick between the app and WhatsApp Web.
 */

/**
 * The digits WhatsApp expects: full international number, no "+", no spaces.
 *
 * Returns `null` unless the stored phone both names its country and has a
 * plausible national number for it. We refuse to assume Lebanon for a bare
 * number, because guessing wrong means opening a chat with a stranger and
 * sending them someone else's medical form — and a number with a country code
 * but an impossible length ("+961 12") is just as wrong to dial. Rows written
 * before the schema enforced this, or imported from elsewhere, can still look
 * like either. Callers disable the button and ask staff to fix the number.
 */
export function toWhatsAppDigits(phone: string): string | null {
  if (!phone || !isValidInternationalPhone(phone)) return null;
  const digits = digitsOnly(phone.trim().replace(/^00/, ""));
  return digits.length > 0 ? digits : null;
}

/**
 * A `wa.me` deep link that opens a chat with `phone`, optionally with `text`
 * pre-typed into the composer. `null` when the number isn't usable — see
 * {@link toWhatsAppDigits}.
 */
export function whatsAppChatUrl(phone: string, text?: string): string | null {
  const digits = toWhatsAppDigits(phone);
  if (!digits) return null;
  const query = text?.trim() ? `?text=${encodeURIComponent(text.trim())}` : "";
  return `https://wa.me/${digits}${query}`;
}

/** Shown in place of the button when the patient's phone can't be dialled. */
export const WHATSAPP_BAD_PHONE_MESSAGE =
  "This patient's phone number isn't a complete international number, so WhatsApp can't open a chat for it. Edit the patient's phone to include a country code and a full number (e.g. +961 70 000 000) and try again.";

/** The message pre-typed into the chat alongside a Food List PDF. */
export function foodListMessage(firstName: string): string {
  const name = firstName.trim();
  return name
    ? `Hello ${name}, here is your Food List form from Layaka.`
    : "Hello, here is your Food List form from Layaka.";
}
