import { Prisma } from "@prisma/client";
import { db } from "../db";
import {
  asAppointmentStatus,
  asVisitType,
  dateOnly,
} from "../serialize";
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
  await db.appointment.updateMany({
    where: { status: "scheduled", date: { lt: clinicDayRange(todayIso()).gte } },
    data: { status: "no_show" },
  });
}

export async function listAppointments(
  date?: string,
  opts: { includeMedicalHistoryStatus?: boolean } = {},
): Promise<Appointment[]> {
  await expirePastScheduledAppointments();
  const where = date ? { date: clinicDayRange(date) } : undefined;
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
  const row = await db.appointment.create({
    data: {
      clientId: input.clientId,
      dietitianId: input.dietitianId ?? null,
      date: new Date(input.date),
      time: input.time,
      status: "scheduled",
      visitType: input.visitType,
      notes: input.notes,
    },
    include,
  });
  return toAppointment(row, opts);
}

export async function updateAppointmentStatus(
  id: string,
  status: string,
  opts: { includeMedicalHistoryStatus?: boolean } = {},
): Promise<Appointment> {
  const row = await db.appointment.update({
    where: { id },
    // Keep completedAt in step with the status: stamp it when an appointment
    // becomes completed, clear it if it's ever moved back out — so "Done" only
    // treats a genuinely-completed appointment as finished today.
    data: { status, completedAt: status === "completed" ? new Date() : null },
    include,
  });
  return toAppointment(row, opts);
}
