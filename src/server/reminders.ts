import { db } from "./db";
import { sendWhatsAppTemplate, isWhatsAppConfigured } from "./whatsapp";
import { withClinicTime } from "@/lib/config";
import { formatDate, formatTime } from "@/lib/utils";

// The approved WhatsApp template used for reminders. Its body must have 3
// variables, in order: {{1}} patient name, {{2}} appointment date, {{3}}
// appointment time. Both the 24h and 1h reminders use the same template — the
// body states the real date/time, so it reads correctly whenever it's sent.
// Override the name/language via env if your approved template differs.
const TEMPLATE_24H = process.env.WHATSAPP_TEMPLATE_24H || "appointment_reminder";
const TEMPLATE_1H = process.env.WHATSAPP_TEMPLATE_1H || "appointment_reminder";
const TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG || "en_US";

const HOUR = 60 * 60 * 1000;

export interface ReminderRun {
  checked: number;
  sent24h: number;
  sent1h: number;
  skipped: number;
  errors: string[];
}

/** The appointment's real instant (ms) in clinic time, from its date + "HH:MM". */
function appointmentInstant(date: Date, time: string): number {
  return new Date(withClinicTime(date.toISOString(), time)).getTime();
}

/**
 * Sends any WhatsApp reminders now due. Two per appointment, each sent once:
 *  - 24h reminder: fires the first run the appointment is within 24h (and >1h) away
 *  - 1h reminder:  fires when the appointment is 0–1h away
 * Idempotent: the reminderNNSentAt columns guarantee no double-sends, so this is
 * safe to run on a frequent schedule (e.g. every 30 min). (The final-reminder
 * flag is stored in the `reminder2hSentAt` column — the name is retained from
 * the original schema; it now marks the ~1h reminder.)
 */
export async function runAppointmentReminders(now: Date = new Date()): Promise<ReminderRun> {
  const result: ReminderRun = { checked: 0, sent24h: 0, sent1h: 0, skipped: 0, errors: [] };
  if (!isWhatsAppConfigured()) {
    result.errors.push("WhatsApp not configured (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID).");
    return result;
  }

  // Only upcoming, still-scheduled visits that still need at least one reminder.
  const appts = await db.appointment.findMany({
    where: {
      status: "scheduled",
      OR: [{ reminder24hSentAt: null }, { reminder2hSentAt: null }],
    },
    include: { client: true },
  });

  for (const a of appts) {
    if (!a.client) continue;
    if (!a.client.whatsappOptIn) { result.skipped++; continue; }
    const phone = a.client.phone?.trim();
    if (!phone) { result.skipped++; continue; }

    const hoursUntil = (appointmentInstant(a.date, a.time) - now.getTime()) / HOUR;
    if (hoursUntil <= 0) continue; // already started / past
    result.checked++;

    // Template body params: {{1}} name, {{2}} date, {{3}} time — same for both
    // reminders (the message states the actual appointment date/time).
    const params = [
      a.client.firstName,
      formatDate(a.date.toISOString()),
      formatTime(a.time),
    ];

    // 1h reminder takes priority in the final stretch.
    if (!a.reminder2hSentAt && hoursUntil <= 1) {
      const r = await sendWhatsAppTemplate(phone, TEMPLATE_1H, TEMPLATE_LANG, params);
      if (r.ok) {
        await db.appointment.update({ where: { id: a.id }, data: { reminder2hSentAt: now } });
        result.sent1h++;
      } else {
        result.errors.push(`1h ${a.id}: ${r.error}`);
      }
      continue;
    }

    // 24h reminder: once, any time within a day of the visit but before the 1h window.
    if (!a.reminder24hSentAt && hoursUntil > 1 && hoursUntil <= 24) {
      const r = await sendWhatsAppTemplate(phone, TEMPLATE_24H, TEMPLATE_LANG, params);
      if (r.ok) {
        await db.appointment.update({ where: { id: a.id }, data: { reminder24hSentAt: now } });
        result.sent24h++;
      } else {
        result.errors.push(`24h ${a.id}: ${r.error}`);
      }
    }
  }

  return result;
}
