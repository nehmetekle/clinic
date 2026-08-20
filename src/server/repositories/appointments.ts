import { Prisma } from "@prisma/client";
import { db } from "../db";
import {
  asAppointmentStatus,
  asVisitType,
  dateOnly,
} from "../serialize";
import { ConflictError, NotFoundError } from "../http";
import { clinicDayRange, todayIso } from "@/lib/config";
import type { Appointment } from "@/lib/types";

const include = {
  client: { include: { medicalHistory: { select: { id: true } } } },
  dietitian: true,
} satisfies Prisma.AppointmentInclude;

type AppointmentRow = Prisma.AppointmentGetPayload<{ include: typeof include }>;

export function toAppointment(
  a: AppointmentRow,
  opts: { includeMedicalHistoryStatus?: boolean } = {},
): Appointment {
  const appointment: Appointment = {
    id: a.id,
    clientId: a.clientId,
    clientName: `${a.client.firstName} ${a.client.lastName}`,
    dietitianId: a.dietitianId ?? undefined,
    dietitianName: a.dietitian?.fullName ?? "Unassigned",
    date: dateOnly(a.date)!,
    time: a.time,
    status: asAppointmentStatus(a.status),
    visitType: asVisitType(a.visitType),
    completedAt: a.completedAt?.toISOString(),
    notes: a.notes ?? undefined,
    referralSource: a.client.referralSource ?? undefined,
    intakeComplete: a.client.intakeComplete,
    firstTimePatient: a.client.firstTimePatient,
  };
  if (opts.includeMedicalHistoryStatus ?? true) {
    appointment.hasMedicalHistory = a.client.medicalHistory != null;
  }
  return appointment;
}

/**
 * Auto-resolve stale bookings: any appointment still `scheduled` on a clinic-day
 * before today was never checked in, cancelled or marked — the client didn't show.
 * The queue for a past day is read-only and the profile only cancels future dates,
 * so without this sweep such a row would read "Scheduled" in history forever. We
 * persist the transition (rather than deriving it) so the record is corrected once
 * and stays consistent with every write path. Idempotent: matches 0 rows once
 * caught up, and runs lazily on every appointment read since there is no cron.
 */
export async function expirePastScheduledAppointments(): Promise<void> {
  // Also clears activeSlotKey: "no_show" is a terminal status, so the slot must
  // stop being occupied — otherwise the stale key would permanently block
  // rebooking the same client/dietitian/date/time.
  await db.appointment.updateMany({
    where: { status: "scheduled", date: { lt: clinicDayRange(todayIso()).gte } },
    data: { status: "no_show", activeSlotKey: null },
  });
}

const ACTIVE_APPOINTMENT_STATUSES = ["scheduled", "checked_in", "with_dietitian"];

/**
 * The value of `Appointment.activeSlotKey` for a given status/dietitian — the
 * column the `activeSlotKey` unique index enforces. Set on EVERY write that
 * can change status, dietitianId, date or time. Null whenever the booking
 * isn't actually occupying a slot (terminal status, or no dietitian assigned
 * yet), so any number of such rows can coexist — see the schema comment.
 */
function activeSlotKey(
  status: string,
  clientId: string,
  dietitianId: string | null,
  dateIso: string,
  time: string,
): string | null {
  if (!ACTIVE_APPOINTMENT_STATUSES.includes(status) || !dietitianId) return null;
  return `${clientId}|${dietitianId}|${dateIso}|${time}`;
}

const DOUBLE_BOOKED_MESSAGE =
  "This client already has an appointment with this dietitian at this date and time.";

export async function listAppointments(
  date?: string,
  opts: {
    includeMedicalHistoryStatus?: boolean;
    /** Restrict to bookings explicitly assigned to this doctor. */
    dietitianId?: string;
  } = {},
): Promise<Appointment[]> {
  await expirePastScheduledAppointments();
  const where: Prisma.AppointmentWhereInput = date ? { date: clinicDayRange(date) } : {};
  // Strict ownership: only bookings actually bound to this doctor. Unassigned
  // ones are deliberately NOT included — this scoping exists so a doctor's own
  // history page carries no other patients at all, and an unowned booking is the
  // front desk's to route (the queue board is where it gets picked up). The admin
  // is never scoped, so nothing becomes invisible clinic-wide.
  if (opts.dietitianId) where.dietitianId = opts.dietitianId;
  const rows = await db.appointment.findMany({
    where,
    include,
    orderBy: [{ date: "asc" }, { time: "asc" }],
  });
  return rows.map((row) => toAppointment(row, opts));
}

export async function createAppointment(
  input: {
    clientId: string;
    dietitianId?: string | null;
    date: string;
    time: string;
    visitType: string;
    notes?: string;
  },
  opts: { includeMedicalHistoryStatus?: boolean } = {},
): Promise<Appointment> {
  try {
    const row = await db.appointment.create({
      data: {
        clientId: input.clientId,
        dietitianId: input.dietitianId ?? null,
        date: new Date(input.date),
        time: input.time,
        status: "scheduled",
        visitType: input.visitType,
        notes: input.notes,
        activeSlotKey: activeSlotKey(
          "scheduled",
          input.clientId,
          input.dietitianId ?? null,
          input.date,
          input.time,
        ),
      },
      include,
    });
    return toAppointment(row, opts);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new ConflictError(DOUBLE_BOOKED_MESSAGE);
    }
    throw e;
  }
}

export async function updateAppointmentStatus(
  id: string,
  status: string,
  opts: {
    includeMedicalHistoryStatus?: boolean;
    // When provided (undefined = leave unchanged), reassigns the visit's doctor
    // in the same write as the status change — used by check-in to bind the
    // patient to the confirmed doctor so they land in only that doctor's queue.
    dietitianId?: string | null;
  } = {},
): Promise<Appointment> {
  const existing = await db.appointment.findUnique({
    where: { id },
    select: { clientId: true, dietitianId: true, date: true, time: true },
  });
  if (!existing) throw new NotFoundError("Appointment not found");
  const dietitianId = opts.dietitianId !== undefined ? opts.dietitianId : existing.dietitianId;
  try {
    const row = await db.appointment.update({
      where: { id },
      // Keep completedAt in step with the status: stamp it when an appointment
      // becomes completed, clear it if it's ever moved back out — so "Done" only
      // treats a genuinely-completed appointment as finished today.
      data: {
        status,
        completedAt: status === "completed" ? new Date() : null,
        ...(opts.dietitianId !== undefined ? { dietitianId: opts.dietitianId } : {}),
        activeSlotKey: activeSlotKey(status, existing.clientId, dietitianId, dateOnly(existing.date)!, existing.time),
      },
      include,
    });
    return toAppointment(row, opts);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new ConflictError(DOUBLE_BOOKED_MESSAGE);
    }
    throw e;
  }
}

/**
 * Move an existing booking to a new slot (date/time), optionally reassigning the
 * doctor or correcting the visit type. Edits the row in place — the appointment
 * keeps its id and its `scheduled` status, so nothing downstream (queue, basket,
 * consultation) has to be re-pointed and the profile shows one row per booking.
 *
 * Only a still-`scheduled` appointment can move: once a patient is checked in,
 * with the dietitian, or the visit is closed/cancelled/no-showed, the slot is
 * history and "rescheduling" it would rewrite what actually happened — book a
 * new appointment instead.
 */
export async function rescheduleAppointment(
  id: string,
  input: {
    dietitianId?: string | null;
    date: string;
    time: string;
    visitType: string;
  },
  opts: { includeMedicalHistoryStatus?: boolean } = {},
): Promise<Appointment> {
  // Sweep first, so an appointment this read would auto-mark `no_show` can't be
  // rescheduled through a stale `scheduled` status.
  await expirePastScheduledAppointments();
  const existing = await db.appointment.findUnique({
    where: { id },
    select: { status: true, clientId: true },
  });
  if (!existing) throw new NotFoundError("Appointment not found");
  if (existing.status !== "scheduled") {
    throw new ConflictError("Only a scheduled appointment can be rescheduled.");
  }
  try {
    const row = await db.appointment.update({
      where: { id },
      data: {
        dietitianId: input.dietitianId ?? null,
        date: new Date(input.date),
        time: input.time,
        visitType: input.visitType,
        // Clear the WhatsApp reminder stamps: they record that the patient was
        // told about the OLD slot. `runAppointmentReminders` only picks up rows
        // with a null stamp, so leaving them set would silently deny the patient
        // both reminders for the slot they were actually moved to.
        reminder24hSentAt: null,
        reminder2hSentAt: null,
        activeSlotKey: activeSlotKey(
          "scheduled",
          existing.clientId,
          input.dietitianId ?? null,
          input.date,
          input.time,
        ),
      },
      include,
    });
    return toAppointment(row, opts);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new ConflictError(DOUBLE_BOOKED_MESSAGE);
    }
    throw e;
  }
}
