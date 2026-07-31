import { db } from "./db";
import { sendWhatsAppTemplate, isWhatsAppConfigured } from "./whatsapp";
import { withClinicTime } from "@/lib/config";

// Which approved template each reminder uses. Defaults to "hello_world" (the
// template every test number has) so the pipeline is testable before go-live;
// swap for your approved production templates via env at Step 9.
const TEMPLATE_24H = process.env.WHATSAPP_TEMPLATE_24H || "hello_world";
const TEMPLATE_2H = process.env.WHATSAPP_TEMPLATE_2H || "hello_world";
const TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG || "en_US";

const HOUR = 60 * 60 * 1000;

export interface ReminderRun {
  checked: number;
  sent24h: number;
  sent2h: number;
  skipped: number;
  errors: string[];
}

/** The appointment's real instant (ms) in clinic time, from its date + "HH:MM". */
function appointmentInstant(date: Date, time: string): number {
  return new Date(withClinicTime(date.toISOString(), time)).getTime();
}

/**
 * Sends any WhatsApp reminders now due. Two per appointment, each sent once:
 *  - 24h reminder: fires the first run the appointment is within 24h (and >2h) away
 *  - 2h reminder:  fires when the appointment is 0–2h away
 * Idempotent: the reminderNNSentAt columns guarantee no double-sends, so this is
 * safe to run on a frequent schedule (e.g. every 30 min).
 */
export async function runAppointmentReminders(now: Date = new Date()): Promise<ReminderRun> {
  const result: ReminderRun = { checked: 0, sent24h: 0, sent2h: 0, skipped: 0, errors: [] };
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

    // 2h reminder takes priority in the final stretch.
    if (!a.reminder2hSentAt && hoursUntil <= 2) {
      const r = await sendWhatsAppTemplate(phone, TEMPLATE_2H, TEMPLATE_LANG);
      if (r.ok) {
        await db.appointment.update({ where: { id: a.id }, data: { reminder2hSentAt: now } });
        result.sent2h++;
      } else {
        result.errors.push(`2h ${a.id}: ${r.error}`);
      }
      continue;
    }

    // 24h reminder: once, any time within a day of the visit but before the 2h window.
    if (!a.reminder24hSentAt && hoursUntil > 2 && hoursUntil <= 24) {
      const r = await sendWhatsAppTemplate(phone, TEMPLATE_24H, TEMPLATE_LANG);
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
