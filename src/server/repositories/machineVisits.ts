import { Prisma } from "@prisma/client";
import { db } from "../db";
import { ConflictError, ForbiddenError, NotFoundError } from "../http";
import { asCurrency } from "../serialize";
import { writeAudit } from "./audit";
import {
  consumeClientPackageTx,
  consumeSessionPlanTx,
  releaseClientPackageTx,
  releaseSessionPlanTx,
} from "./sessionCounters";
import { getUsdToLbp } from "./settings";
import type { Currency, MachineVisit, MachineVisitItem, Role } from "@/lib/types";

/**
 * Machine visits — a patient who came only to use prepaid machine sessions.
 *
 * Deliberately NOT a consultation: no measurements, no notes beyond a free line,
 * no consultation fee, no visit number, no close/basket state machine. What it
 * does share with a consultation is the accounting: sessions are consumed through
 * the same guarded counters (repositories/sessionCounters.ts), and sessions the
 * patient has not prepaid raise an ordinary pending VisitBasket that the
 * secretary settles through the existing checkout — same unit price, same frozen
 * rate, same receipts.
 */

const include = {
  items: { orderBy: { createdAt: "asc" } },
  client: { select: { firstName: true, lastName: true } },
  baskets: { select: { id: true, status: true } },
} satisfies Prisma.MachineVisitInclude;

type MachineVisitRow = Prisma.MachineVisitGetPayload<{ include: typeof include }>;

/** Appointment states a client can be in while physically at the clinic. */
const LIVE_APPOINTMENT_STATUSES = ["scheduled", "checked_in", "with_dietitian"];

export function toMachineVisit(row: MachineVisitRow): MachineVisit {
  const items: MachineVisitItem[] = row.items.map((i) => ({
    id: i.id,
    machine: i.machine,
    sessions: i.sessions,
    billedSessions: i.billedSessions,
    unitPrice: i.unitPrice,
    currency: asCurrency(i.currency),
    sessionPlanId: i.sessionPlanId ?? undefined,
    clientPackageId: i.clientPackageId ?? undefined,
  }));
  const openBasket = row.baskets.find((b) => b.status === "pending");
  return {
    id: row.id,
    clientId: row.clientId,
    clientName: `${row.client.firstName} ${row.client.lastName}`,
    date: row.date.toISOString(),
    note: row.note ?? undefined,
    status: row.status === "voided" ? "voided" : "recorded",
    recordedByName: row.recordedByName,
    appointmentId: row.appointmentId ?? undefined,
    items,
    sessionsTotal: items.reduce((s, i) => s + i.sessions, 0),
    // What this visit put on the counter, if anything. Settled through the normal
    // checkout, so once paid it is ordinary income like any other basket.
    amountDue: items.reduce((s, i) => s + i.billedSessions * i.unitPrice, 0),
    pendingBasketId: openBasket?.id,
    voidedAt: row.voidedAt?.toISOString(),
    voidedByName: row.voidedByName ?? undefined,
    voidReason: row.voidReason ?? undefined,
  };
}

export async function listMachineVisits(filter: {
  clientId?: string;
  from?: string;
  to?: string;
}): Promise<MachineVisit[]> {
  const rows = await db.machineVisit.findMany({
    where: {
      clientId: filter.clientId,
      ...(filter.from || filter.to
        ? {
            date: {
              ...(filter.from ? { gte: new Date(`${filter.from}T00:00:00.000Z`) } : {}),
              ...(filter.to ? { lte: new Date(`${filter.to}T23:59:59.999Z`) } : {}),
            },
          }
        : {}),
    },
    include,
    orderBy: { date: "desc" },
  });
  return rows.map(toMachineVisit);
}

export async function getMachineVisit(id: string): Promise<MachineVisit | null> {
  const row = await db.machineVisit.findUnique({ where: { id }, include });
  return row ? toMachineVisit(row) : null;
}

export type MachineVisitItemInput = {
  sessionPlanId?: string | null;
  clientPackageId?: string | null;
  sessions: number;
};

export type CreateMachineVisitInput = {
  clientId: string;
  items: MachineVisitItemInput[];
  note?: string;
  appointmentId?: string | null;
  idempotencyKey?: string | null;
};

export type MachineVisitActor = {
  id: string | null;
  name: string;
  role: Role | null;
};

/**
 * Completes the appointment this visit closed out.
 *
 * Explicit beats inferred: when the queue hands over an appointment id we act on
 * THAT row (after proving it belongs to this patient — the id comes from the
 * browser). With no id we only auto-complete when the patient has exactly one
 * appointment in a live state; two candidates or none leaves the visit unlinked
 * rather than completing a guess. This is stricter than the consultation path's
 * `completeLinkedAppointmentTx`, which completes every live appointment a client
 * has.
 */
async function resolveAppointmentTx(
  tx: Prisma.TransactionClient,
  clientId: string,
  appointmentId: string | null | undefined,
): Promise<string | null> {
  if (appointmentId) {
    const appt = await tx.appointment.findUnique({
      where: { id: appointmentId },
      select: { id: true, clientId: true, status: true },
    });
    if (!appt) throw new NotFoundError("Appointment not found");
    // IDOR guard: an id from the client is never trusted to belong to this patient.
    if (appt.clientId !== clientId) {
      throw new ForbiddenError("That appointment belongs to another patient.");
    }
    if (appt.status === "completed") return appt.id; // already done — link, change nothing
    if (!LIVE_APPOINTMENT_STATUSES.includes(appt.status)) {
      throw new ConflictError("This appointment is no longer open.");
    }
    await tx.appointment.updateMany({
      where: { id: appt.id, status: { in: LIVE_APPOINTMENT_STATUSES } },
      data: { status: "completed", completedAt: new Date() },
    });
    return appt.id;
  }

  const live = await tx.appointment.findMany({
    where: { clientId, status: { in: ["checked_in", "with_dietitian"] } },
    select: { id: true },
  });
  if (live.length !== 1) return null; // ambiguous or absent — never guess
  await tx.appointment.updateMany({
    where: { id: live[0].id, status: { in: ["checked_in", "with_dietitian"] } },
    data: { status: "completed", completedAt: new Date() },
  });
  return live[0].id;
}

/**
 * Records a machine visit: consumes the sessions, bills whatever prepaid credit
 * didn't cover, completes the appointment, writes the audit line — one
 * transaction, so a failure anywhere leaves no half-recorded visit.
 */
export async function createMachineVisit(
  input: CreateMachineVisitInput,
  actor: MachineVisitActor,
): Promise<MachineVisit> {
  if (input.items.length === 0) throw new ConflictError("Select at least one treatment.");

  // One line per source: two lines drawing on the same plan would each price
  // themselves against the same credit and over-bill the patient.
  const sourceKeys = input.items.map((i) => i.sessionPlanId ?? i.clientPackageId ?? "");
  if (new Set(sourceKeys).size !== sourceKeys.length) {
    throw new ConflictError("Each treatment can only be logged once per visit.");
  }
  for (const item of input.items) {
    const sources = [item.sessionPlanId, item.clientPackageId].filter(Boolean).length;
    if (sources !== 1) throw new ConflictError("Each line must draw on exactly one treatment.");
    if (!Number.isInteger(item.sessions) || item.sessions < 1) {
      throw new ConflictError("Sessions must be a whole number of at least 1.");
    }
  }

  // Frozen outside the transaction (it reads Settings), like every other basket.
  const usdToLbp = await getUsdToLbp();

  const created = await db
    .$transaction(async (tx) => {
      if (input.idempotencyKey) {
        const replay = await tx.machineVisit.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
          select: { id: true },
        });
        if (replay) return replay.id;
      }

      const client = await tx.client.findUnique({
        where: { id: input.clientId },
        select: { id: true },
      });
      if (!client) throw new NotFoundError("Client not found");

      const visit = await tx.machineVisit.create({
        data: {
          clientId: input.clientId,
          recordedById: actor.id,
          recordedByName: actor.name,
          note: input.note?.trim() || null,
          idempotencyKey: input.idempotencyKey || null,
        },
      });

      type Line = {
        machine: string;
        sessions: number;
        billed: number;
        unitPrice: number;
        currency: Currency;
        sessionPlanId: string | null;
        clientPackageId: string | null;
      };
      const lines: Line[] = [];

      for (const item of input.items) {
        if (item.sessionPlanId) {
          const plan = await tx.sessionPlan.findUnique({ where: { id: item.sessionPlanId } });
          // Ownership before anything else: a plan id from the browser must belong
          // to the patient being logged, or this is one client spending another's.
          if (!plan || plan.clientId !== input.clientId) {
            throw new NotFoundError("Treatment plan not found for this patient.");
          }
          if (plan.status === "cancelled") throw new ConflictError("This treatment plan is cancelled.");

          // Prepaid credit covers today first; only what it can't cover is billed.
          // The price is the plan's OWN frozen unit price — never sent by the
          // client, never re-read from the catalog, so it matches to the cent what
          // the same session would have cost through a consultation.
          const credit = Math.max(0, plan.sessionsPaid - plan.sessionsUsed);
          const billed = Math.max(0, item.sessions - credit);

          await consumeSessionPlanTx(tx, {
            planId: plan.id,
            clientId: input.clientId,
            sessions: item.sessions,
            // A machine visit consumes; it never buys. Capping at `sessionsNeeded`
            // is what keeps it from quietly enlarging the plan.
            ceiling: true,
          });

          lines.push({
            machine: plan.machine ?? "Treatment",
            sessions: item.sessions,
            billed,
            unitPrice: plan.unitPrice,
            currency: asCurrency(plan.currency),
            sessionPlanId: plan.id,
            clientPackageId: null,
          });
          continue;
        }

        const cp = await tx.clientPackage.findUnique({ where: { id: item.clientPackageId! } });
        if (!cp || cp.clientId !== input.clientId) {
          throw new NotFoundError("Bundle not found for this patient.");
        }
        if (cp.status === "cancelled") throw new ConflictError("This bundle is cancelled.");
        await consumeClientPackageTx(tx, {
          packageId: cp.id,
          clientId: input.clientId,
          sessions: item.sessions,
        });
        // A bundle is prepaid in full at its fixed price — consuming it never bills.
        lines.push({
          machine: cp.machine ?? cp.packageName,
          sessions: item.sessions,
          billed: 0,
          unitPrice: 0,
          currency: asCurrency(cp.currency),
          sessionPlanId: null,
          clientPackageId: cp.id,
        });
      }

      for (const line of lines) {
        await tx.machineVisitItem.create({
          data: {
            machineVisitId: visit.id,
            machine: line.machine,
            sessions: line.sessions,
            billedSessions: line.billed,
            unitPrice: line.unitPrice,
            currency: line.currency,
            sessionPlanId: line.sessionPlanId,
            clientPackageId: line.clientPackageId,
          },
        });
      }

      // Sessions the patient hadn't prepaid go on an ordinary pending basket —
      // the same rows, the same settlement, the same receipts as a consultation's.
      // Covered lines are recorded (not charged) so the checkout shows what today
      // actually used. No consultation fee: nobody consulted.
      const billedLines = lines.filter((l) => l.billed > 0);
      if (billedLines.length > 0) {
        await tx.visitBasket.create({
          data: {
            clientId: input.clientId,
            dietitianId: actor.id,
            machineVisitId: visit.id,
            status: "pending",
            currency: "USD",
            usdToLbp,
            items: {
              create: lines.flatMap((l) => {
                const rows: Prisma.VisitBasketItemCreateWithoutBasketInput[] = [];
                const covered = l.sessions - l.billed;
                if (covered > 0) {
                  rows.push({
                    kind: "treatment",
                    label: l.machine,
                    detail: `${covered} covered by credit`,
                    quantity: covered,
                    unitPrice: l.unitPrice,
                    currency: l.currency,
                    covered: true,
                    ...(l.sessionPlanId ? { sessionPlan: { connect: { id: l.sessionPlanId } } } : {}),
                  });
                }
                if (l.billed > 0) {
                  rows.push({
                    kind: "treatment",
                    label: l.machine,
                    detail: `${l.billed} session${l.billed === 1 ? "" : "s"} purchased`,
                    quantity: l.billed,
                    unitPrice: l.unitPrice,
                    currency: l.currency,
                    covered: false,
                    ...(l.sessionPlanId ? { sessionPlan: { connect: { id: l.sessionPlanId } } } : {}),
                  });
                }
                return rows;
              }),
            },
          },
        });
      }

      const appointmentId = await resolveAppointmentTx(tx, input.clientId, input.appointmentId);
      if (appointmentId) {
        await tx.machineVisit.update({ where: { id: visit.id }, data: { appointmentId } });
      }

      const label = lines.map((l) => `${l.machine} ×${l.sessions}`).join(", ");
      await writeAudit(tx, {
        userId: actor.id,
        userName: actor.name,
        action: "Logged machine visit",
        entityType: "MachineVisit",
        entityLabel: label,
      });

      return visit.id;
    })
    .catch(async (e) => {
      // Two identical submits racing: the database settles it on the unique key.
      // The loser returns the winner's visit rather than a failure — a replayed
      // confirm must never consume a second set of sessions.
      if (
        input.idempotencyKey &&
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002"
      ) {
        const existing = await db.machineVisit.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
          select: { id: true },
        });
        if (existing) return existing.id;
      }
      throw e;
    });

  const view = await getMachineVisit(created);
  if (!view) throw new NotFoundError("Machine visit not found");
  return view;
}

/**
 * Voids a machine visit: the row stays in history, its sessions come back, and
 * the basket it raised (if still unpaid) disappears with it.
 *
 * Refused once money has been collected. The app has no refund or payment
 * reversal anywhere by design, so a settled basket is the end of the line — the
 * correction there is a clinic-side one, not a database one.
 */
export async function voidMachineVisit(
  id: string,
  input: { reason?: string },
  actor: MachineVisitActor,
): Promise<MachineVisit> {
  await db.$transaction(async (tx) => {
    const visit = await tx.machineVisit.findUnique({
      where: { id },
      include: { items: true, baskets: { select: { id: true, status: true } } },
    });
    if (!visit) throw new NotFoundError("Machine visit not found");
    if (visit.status === "voided") throw new ConflictError("This machine visit is already voided.");

    // A dietitian corrects their own mistake; the admin corrects anyone's.
    if (actor.role === "dietitian" && visit.recordedById !== actor.id) {
      throw new ForbiddenError("You can only void a machine visit you recorded.");
    }

    if (visit.baskets.some((b) => b.status !== "pending")) {
      throw new ConflictError(
        "This machine visit has been paid for and can't be voided — payments are never reversed.",
      );
    }

    // Claim the void first: a second request waits on the row and then matches
    // nothing, so the sessions below are given back exactly once.
    const claimed = await tx.machineVisit.updateMany({
      where: { id, status: "recorded" },
      data: {
        status: "voided",
        voidedAt: new Date(),
        voidedById: actor.id,
        voidedByName: actor.name,
        voidReason: input.reason?.trim() || null,
      },
    });
    if (claimed.count === 0) throw new ConflictError("This machine visit is already voided.");

    await tx.visitBasket.deleteMany({ where: { machineVisitId: id, status: "pending" } });

    for (const item of visit.items) {
      if (item.sessionPlanId) await releaseSessionPlanTx(tx, item.sessionPlanId, item.sessions);
      if (item.clientPackageId) await releaseClientPackageTx(tx, item.clientPackageId, item.sessions);
    }

    await writeAudit(tx, {
      userId: actor.id,
      userName: actor.name,
      action: "Voided machine visit",
      entityType: "MachineVisit",
      entityLabel: `${visit.items.map((i) => `${i.machine} ×${i.sessions}`).join(", ")}${
        input.reason?.trim() ? ` — ${input.reason.trim()}` : ""
      }`,
    });
  });

  const view = await getMachineVisit(id);
  if (!view) throw new NotFoundError("Machine visit not found");
  return view;
}

/**
 * Machine utilization over a date range: sessions actually delivered and how many
 * visits delivered them, per machine. Voided visits are excluded — they never
 * happened. Sessions delivered inside a consultation are counted too, so the
 * report answers "how much was this machine used", not "how was it booked".
 *
 * Consultation sessions count only from CLOSED visits. An open draft is still
 * being edited — its session counts change with every save and can be removed
 * altogether — so counting it would let a report move without anything happening
 * in the clinic. This is a reporting rule only: an open draft's usage still draws
 * on the plan's balance exactly as before, and plans stay usable by later
 * consultations and machine visits until their sessions run out.
 */
export async function machineUtilization(range: { from?: string; to?: string }): Promise<
  { machine: string; sessions: number; machineVisits: number; consultationSessions: number }[]
> {
  const dateFilter = {
    ...(range.from ? { gte: new Date(`${range.from}T00:00:00.000Z`) } : {}),
    ...(range.to ? { lte: new Date(`${range.to}T23:59:59.999Z`) } : {}),
  };
  const hasRange = range.from !== undefined || range.to !== undefined;

  const [visitRows, consultRows] = await Promise.all([
    db.machineVisit.findMany({
      where: { status: "recorded", ...(hasRange ? { date: dateFilter } : {}) },
      include: { items: true },
    }),
    db.consultationTreatment.findMany({
      where: {
        sessionsUsed: { gt: 0 },
        consultation: { status: "closed", ...(hasRange ? { date: dateFilter } : {}) },
      },
      select: { machine: true, machineOther: true, sessionsUsed: true },
    }),
  ]);

  const by = new Map<
    string,
    { machine: string; sessions: number; machineVisits: number; consultationSessions: number }
  >();
  const row = (machine: string) => {
    let r = by.get(machine);
    if (!r) {
      r = { machine, sessions: 0, machineVisits: 0, consultationSessions: 0 };
      by.set(machine, r);
    }
    return r;
  };

  for (const v of visitRows) {
    const seen = new Set<string>();
    for (const item of v.items) {
      const r = row(item.machine);
      r.sessions += item.sessions;
      // One visit counts once per machine, however many lines it has.
      if (!seen.has(item.machine)) {
        r.machineVisits += 1;
        seen.add(item.machine);
      }
    }
  }
  for (const t of consultRows) {
    const label = t.machine === "Other" ? t.machineOther || "Other" : t.machine;
    const r = row(label);
    r.sessions += t.sessionsUsed;
    r.consultationSessions += t.sessionsUsed;
  }

  return [...by.values()].sort((a, b) => b.sessions - a.sessions || a.machine.localeCompare(b.machine));
}
