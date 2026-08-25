import { db } from "./db";
import { sendWhatsAppTemplate, isWhatsAppConfigured, type WhatsAppResult } from "./whatsapp";
import { withClinicTime } from "@/lib/config";
import { formatDate, formatTime } from "@/lib/utils";

// The WhatsApp template(s) used for reminders. Each must have 3 body variables,
// in order: {{1}} patient name, {{2}} appointment date, {{3}} appointment time.
// The same template serves both the 24h and 1h reminders — the body states the
// real date/time, so it reads correctly whenever it's sent.
//
// Candidates are tried in order, falling through to the next ONLY when a template
// isn't usable yet (missing / not-approved). This makes template upgrades
// zero-downtime and self-activating: submit a new version (e.g. one that adds a
// Maps link) as the first candidate with the current approved one as fallback —
// reminders keep sending the old text until Meta approves the new one, then
// automatically switch to it with no code change or manual step. An env override
// (WHATSAPP_TEMPLATE) pins a single template if you ever need to.
const TEMPLATE_CANDIDATES = process.env.WHATSAPP_TEMPLATE
  ? [process.env.WHATSAPP_TEMPLATE]
  : ["appointment_reminder_v2", "appointment_reminder"];
const TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG || "en_US";

// Meta's error for a template that doesn't exist / isn't approved in this language
// yet — the only case where we should fall through to the next candidate.
const TEMPLATE_UNAVAILABLE = /132001|does not exist|not been approved|not.*approv/i;

/** Send the reminder, preferring the first usable (approved) template candidate. */
async function sendReminderTemplate(phone: string, params: string[]): Promise<WhatsAppResult> {
  let last: WhatsAppResult = { ok: false, error: "no reminder template configured" };
  for (const name of TEMPLATE_CANDIDATES) {
    last = await sendWhatsAppTemplate(phone, name, TEMPLATE_LANG, params);
    if (last.ok) return last;
    if (!TEMPLATE_UNAVAILABLE.test(last.error || "")) break; // real error — stop, report it
  }
  return last;
}

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
    //
    // CLAIMED before sending, not just checked: the initial query above reads a
    // stale snapshot, so two overlapping runs (nothing stops concurrent calls to
    // this endpoint once CRON_SECRET is known) could both see the same
    // appointment as "not yet reminded" and both send. The conditional update —
    // `updateMany` guarded on the stamp still being null — claims the slot
    // atomically; only the run that actually flips it from null proceeds to
    // send. A send failure releases the claim so a later run retries.
    if (!a.reminder2hSentAt && hoursUntil <= 1) {
      const claim = await db.appointment.updateMany({
        where: { id: a.id, reminder2hSentAt: null },
        data: { reminder2hSentAt: now },
      });
      if (claim.count === 0) { result.skipped++; continue; } // claimed by a concurrent run
      const r = await sendReminderTemplate(phone, params);
      if (r.ok) {
        result.sent1h++;
      } else {
        await db.appointment.updateMany({
          where: { id: a.id, reminder2hSentAt: now },
          data: { reminder2hSentAt: null },
        });
        result.errors.push(`1h ${a.id}: ${r.error}`);
      }
      continue;
    }

    // 24h reminder: once, any time within a day of the visit but before the 1h window.
    if (!a.reminder24hSentAt && hoursUntil > 1 && hoursUntil <= 24) {
      const claim = await db.appointment.updateMany({
        where: { id: a.id, reminder24hSentAt: null },
        data: { reminder24hSentAt: now },
      });
      if (claim.count === 0) { result.skipped++; continue; } // claimed by a concurrent run
      const r = await sendReminderTemplate(phone, params);
      if (r.ok) {
        result.sent24h++;
      } else {
        await db.appointment.updateMany({
          where: { id: a.id, reminder24hSentAt: now },
          data: { reminder24hSentAt: null },
        });
        result.errors.push(`24h ${a.id}: ${r.error}`);
      }
    }
  }

  return result;
}
