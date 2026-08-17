import { Prisma } from "@prisma/client";
import { db } from "../db";
import { ConflictError, ForbiddenError, NotFoundError } from "../http";
import { asCurrency } from "../serialize";
import { writeAudit } from "./audit";
import { recordReferralCommissionTx } from "./referralCommissions";
import { clinicDayRange } from "@/lib/config";
import {
  consumeClientPackageTx,
  consumeSessionPlanTx,
  releaseClientPackageTx,
  releaseSessionPlanTx,
} from "./sessionCounters";
import { NO_MACHINE_LABEL } from "@/lib/types";
import type { Currency, MachineVisit, MachineVisitItem, Role } from "@/lib/types";

/**
 * Machine visits — a patient who came only to use sessions they already own.
 *
 * Deliberately NOT a consultation: no measurements, no notes beyond a free line,
 * no consultation fee, no visit number, no close/basket state machine.
 *
 * And deliberately NOT a sale: a machine visit is PURE CONSUMPTION. It draws only
 * on sessions that have been bought and settled (`sessionsPaid - sessionsUsed`
 * for a plan, the remaining balance for a bundle) and raises no basket, no
 * charge and no debt. A patient with nothing left is turned back to the desk to
 * buy sessions first — the visit is refused rather than quietly billed.
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
  // Machine visits raise no baskets any more. These two fields describe HISTORIC
  // rows only, from before consumption and purchase were separated.
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
    // Always 0 for visits recorded under the current rules; non-zero only on
    // historic rows that predate purchase and consumption being separated.
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
            // Clinic midnight in the clinic's own timezone, never UTC midnight.
            // Building these from raw "...T00:00:00.000Z" strings shifts the whole
            // window by the UTC offset, so an evening visit falls into the next
            // day and drops out of the period it belongs to. Half-open (`lt` on
            // the day AFTER `to`) so the final day is included whole without the
            // .999 millisecond that an `lte` endpoint silently truncates.
            date: {
              ...(filter.from ? { gte: clinicDayRange(filter.from).gte } : {}),
              ...(filter.to ? { lt: clinicDayRange(filter.to).lt } : {}),
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
 * Records a machine visit: consumes the sessions, completes the appointment,
 * writes the audit line — one transaction, so a failure anywhere leaves no
 * half-recorded visit. Nothing is billed: a line the patient can't cover from
 * settled sessions fails the whole call.
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
        // Catalog machine key, or null when the plan/bundle is not tied to a
        // machine. Never an invented stand-in label — see MachineVisitItem.machine.
        machine: string | null;
        sessions: number;
        unitPrice: number;
        // F-03: the clinic's own per-session cost, frozen from the source the
        // sessions were bought under. A machine visit bills nothing, so this row
        // is the ONLY record that these sessions were delivered at a cost — with
        // no price to carry the economics, the cost has to carry them alone.
        unitCost: number;
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

          // The whole rule, in one call: consume only what has been bought AND
          // settled. Short of that it throws (naming how many are available) — it
          // never tops the difference up as a charge.
          await consumeSessionPlanTx(tx, {
            planId: plan.id,
            clientId: input.clientId,
            sessions: item.sessions,
            limit: "available",
          });

          lines.push({
            // Verbatim from the plan. It used to fall back to the literal
            // "Treatment", which then appeared in machine reports as a machine by
            // that name; a plan with no machine now honestly records none.
            machine: plan.machine,
            sessions: item.sessions,
            // Recorded for the history line only — nothing is charged here.
            unitPrice: plan.unitPrice,
            // Inherited from the plan's own frozen cost, never today's catalog.
            unitCost: plan.unitCost,
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
        // A bundle is prepaid in full at its fixed price — same principle, and
        // over-consuming it is refused rather than clamped.
        await consumeClientPackageTx(tx, {
          packageId: cp.id,
          clientId: input.clientId,
          sessions: item.sessions,
        });
        lines.push({
          // Likewise verbatim: falling back to the bundle's NAME put a product
          // name in the machine column of the utilization report.
          machine: cp.machine,
          sessions: item.sessions,
          unitPrice: 0,
          // A bundle freezes ONE cost for the whole course (ClientPackage.cost),
          // so the per-session cost is that total spread over the sessions it
          // bought. Both numbers were frozen at the sale, so this stays a
          // historical figure — it is not re-derived from the catalog. Guarded
          // against a zero-session bundle so a corrupt row can't produce Infinity.
          unitCost: cp.totalSessions > 0 ? cp.cost / cp.totalSessions : 0,
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
            billedSessions: 0,
            unitPrice: line.unitPrice,
            unitCost: line.unitCost,
            currency: line.currency,
            sessionPlanId: line.sessionPlanId,
            clientPackageId: line.clientPackageId,
          },
        });
      }

      const appointmentId = await resolveAppointmentTx(tx, input.clientId, input.appointmentId);
      if (appointmentId) {
        await tx.machineVisit.update({ where: { id: visit.id }, data: { appointmentId } });
      }

      // A machine visit is a real completed visit, so it triggers the referral
      // commission on the same "first completed visit" rule as a consultation —
      // whichever kind of visit the patient attends first is the one that makes
      // the clinic liable. No-ops for every subsequent visit.
      await recordReferralCommissionTx(
        tx,
        input.clientId,
        { type: "machine_visit", machineVisitId: visit.id },
        actor.name,
      );

      const label = lines.map((l) => `${l.machine ?? NO_MACHINE_LABEL} ×${l.sessions}`).join(", ");
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
 * Voids a machine visit: the row stays in history and its sessions come back
 * exactly (they return to `available`, ready to be used again).
 *
 * Current visits carry no basket at all. The basket handling below is for
 * HISTORIC rows that predate the split: a settled one still blocks the void,
 * because the app has no refund or payment reversal anywhere by design.
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
      entityLabel: `${visit.items.map((i) => `${i.machine ?? NO_MACHINE_LABEL} ×${i.sessions}`).join(", ")}${
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
  {
    machine: string;
    sessions: number;
    machineVisitSessions: number;
    machineVisits: number;
    consultationSessions: number;
  }[]
> {
  // Clinic-day boundaries, matching every other windowed figure on the report —
  // see the note in listMachineVisits.
  const dateFilter = {
    ...(range.from ? { gte: clinicDayRange(range.from).gte } : {}),
    ...(range.to ? { lt: clinicDayRange(range.to).lt } : {}),
  };
  const hasRange = range.from !== undefined || range.to !== undefined;

  const [visitRows, consultRows, catalogMachines] = await Promise.all([
    db.machineVisit.findMany({
      where: { status: "recorded", ...(hasRange ? { date: dateFilter } : {}) },
      include: { items: true },
    }),
    db.consultationTreatment.findMany({
      where: {
        sessionsUsed: { gt: 0 },
        consultation: { status: "closed", ...(hasRange ? { date: dateFilter } : {}) },
      },
      select: { machine: true, sessionsUsed: true },
    }),
    db.servicePrice.findMany({ where: { kind: "treatment" }, select: { key: true } }),
  ]);
  // Machine = one of the clinic's own catalog machines, or no machine — never a
  // third option. New writes are enforced at save time (buildConsultationContentTx,
  // createSessionPlan, sellSessions); this catches stale rows from before that
  // enforcement existed (e.g. the old "Other" bucket) so they don't linger in
  // reports. Matches against every catalog key ever used (not just `active`) so a
  // machine that's merely been retired doesn't drop out of historical reporting.
  const knownMachines = new Set(catalogMachines.map((m) => m.key));

  // Two of these count SESSIONS and one counts VISITS. They are reported as
  // separate fields, and labelled as such, because a single "sessions" total next
  // to a visit count invites the two to be compared as if they were the same
  // thing. The split is also the useful part: `sessions` is the machine's total
  // workload, and `machineVisitSessions` + `consultationSessions` say whether that
  // workload arrived as machine-only attendance or inside a full consultation.
  type Row = {
    machine: string;
    sessions: number;
    machineVisitSessions: number;
    machineVisits: number;
    consultationSessions: number;
  };
  const by = new Map<string, Row>();
  // ONE canonical identity per machine, on both paths: the catalog key stored on
  // the row. Nothing is derived from a label, a bundle name or a free-text field,
  // which is what used to file the same physical machine under two names and split
  // it across two rows. A row with no machine is reported as exactly that.
  const row = (machine: string | null) => {
    const key = machine ?? NO_MACHINE_LABEL;
    let r = by.get(key);
    if (!r) {
      r = { machine: key, sessions: 0, machineVisitSessions: 0, machineVisits: 0, consultationSessions: 0 };
      by.set(key, r);
    }
    return r;
  };

  for (const v of visitRows) {
    const seen = new Set<string>();
    for (const item of v.items) {
      const r = row(item.machine);
      const seenKey = item.machine ?? NO_MACHINE_LABEL;
      r.sessions += item.sessions;
      r.machineVisitSessions += item.sessions;
      // One visit counts once per machine, however many lines it has.
      if (!seen.has(seenKey)) {
        r.machineVisits += 1;
        seen.add(seenKey);
      }
    }
  }
  for (const t of consultRows) {
    const r = row(t.machine);
    r.sessions += t.sessionsUsed;
    r.consultationSessions += t.sessionsUsed;
  }

  return [...by.values()]
    .filter((r) => r.machine === NO_MACHINE_LABEL || knownMachines.has(r.machine))
    .sort((a, b) => b.sessions - a.sessions || a.machine.localeCompare(b.machine));
}
