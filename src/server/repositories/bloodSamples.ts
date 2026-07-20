import { Prisma } from "@prisma/client";
import { db } from "../db";
import { ConflictError, NotFoundError } from "../http";
import { clinicDay, clinicTimeInput } from "@/lib/config";
import { writeAudit } from "./audit";
import { userIdByEmail } from "./staff";
import type { BloodSample, BloodSampleStatus } from "@/lib/types";

/** Acting user for a sample change — its email resolves to a User row, its name
 * is stamped onto the audit entry (mirrors the expense/payment actor). */
type SampleActor = { name: string; email?: string };

// Reasonable bounds for a caller-supplied send/receive time. Same-day time edits
// can legitimately land later "today" than the exact current instant, so a full
// day of forward slack is allowed for clock skew; anything past that (or before
// the clinic could plausibly exist) is an arbitrary/bad date and is rejected.
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;
const EARLIEST_SAMPLE_TS = new Date("2000-01-01T00:00:00.000Z").getTime();

/** Compact stamp for audit labels in the clinic's timezone, e.g. "2026-07-09
 * 14:30" — same clinic-anchored clock the rest of the app displays. */
function auditTime(d: Date): string {
  return `${clinicDay(d)} ${clinicTimeInput(d.toISOString())}`;
}

// Display reads the frozen `dietitianName` snapshot, not the live User relation,
// so only the client is joined. The `dietitianId` FK still records who ordered it.
const include = {
  client: true,
} satisfies Prisma.BloodSampleInclude;

type BloodSampleRow = Prisma.BloodSampleGetPayload<{ include: typeof include }>;

/** Tolerant parse of the JSON-encoded test-name list. */
function parseTests(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Order-insensitive equality of two test-name lists (names are unique per list). */
function sameTests(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/** Status is derived from the timestamps so the record can't contradict itself. */
function deriveStatus(row: { sentAt: Date | null; receivedAt: Date | null }): BloodSampleStatus {
  if (row.receivedAt) return "received";
  if (row.sentAt) return "sent";
  return "pending";
}

export function toBloodSample(b: BloodSampleRow): BloodSample {
  return {
    id: b.id,
    clientId: b.clientId,
    clientName: `${b.client.firstName} ${b.client.lastName}`,
    consultationId: b.consultationId ?? undefined,
    dietitianName: b.dietitianName ?? "Unassigned",
    tests: parseTests(b.tests),
    status: deriveStatus(b),
    orderedAt: b.orderedAt.toISOString(),
    sentAt: b.sentAt?.toISOString(),
    receivedAt: b.receivedAt?.toISOString(),
    notes: b.notes ?? undefined,
  };
}

/**
 * Creates the tracking record for a blood collection ordered on a visit. Runs
 * inside the consultation's transaction so the sample is logged atomically with
 * the visit — the secretary never has to create the entry by hand.
 */
export async function createBloodSampleTx(
  tx: Prisma.TransactionClient,
  input: {
    clientId: string;
    dietitianId?: string | null;
    consultationId: string;
    tests?: string[];
    orderedAt?: Date;
  },
): Promise<void> {
  const tests = input.tests ?? [];
  // Snapshot the ordering dietitian's name now so a later rename never rewrites
  // who ordered this sample (same frozen-name pattern as AuditLog.userName).
  const dietitian = input.dietitianId
    ? await tx.user.findUnique({
        where: { id: input.dietitianId },
        select: { fullName: true },
      })
    : null;
  const dietitianName = dietitian?.fullName ?? null;
  const created = await tx.bloodSample.create({
    data: {
      clientId: input.clientId,
      dietitianId: input.dietitianId ?? null,
      dietitianName,
      consultationId: input.consultationId,
      tests: JSON.stringify(tests),
      orderedAt: input.orderedAt ?? new Date(),
    },
    include,
  });

  // Audit the order itself, attributed to the dietitian who requested it — the
  // same trail the secretary's downstream send/receive/undo actions now write,
  // so a sample's history is complete from the moment it's ordered.
  const clientName = `${created.client.firstName} ${created.client.lastName}`;
  await writeAudit(tx, {
    userId: created.dietitianId,
    userName: dietitianName ?? "Unassigned",
    action: "Ordered blood work",
    entityType: "BloodSample",
    entityLabel: tests.length
      ? `${clientName} — ordered: ${tests.join(", ")}`
      : `${clientName} — ordered (no specific tests)`,
  });
}

/**
 * Records an accountability event when ordered blood test(s) are dropped from a
 * visit's lab order AFTER they were placed (and therefore charged). This is the
 * fraud-relevant case an admin must be able to see plainly: a test was billed,
 * then quietly cancelled before ever reaching the lab. The label names the acting
 * user, the client, the visit, the ordering dietitian, and the exact test(s)
 * removed; the audit row's own timestamp records when. `cancelled` distinguishes a
 * whole-order cancellation from removing some tests off a still-standing order.
 */
async function writeBloodTestRemovalAuditTx(
  tx: Prisma.TransactionClient,
  args: {
    clientName: string;
    visitNumber: number | null;
    orderedBy: string;
    removedTests: string[];
    cancelled: boolean;
    actor?: { name?: string | null; email?: string | null };
  },
): Promise<void> {
  const visit = args.visitNumber != null ? `Visit #${args.visitNumber}` : "an unlinked visit";
  const testList = args.removedTests.length ? args.removedTests.join(", ") : "(no specific tests)";
  const who = args.actor?.name ?? "A user";
  const verb = args.cancelled
    ? "cancelled the blood work order"
    : "removed blood test(s) from the order";
  await writeAudit(tx, {
    userId: await userIdByEmail(args.actor?.email ?? undefined),
    userName: args.actor?.name,
    action: args.cancelled
      ? "Cancelled billed blood test order"
      : "Removed billed blood test",
    entityType: "BloodSample",
    entityLabel:
      `${who} ${verb} for ${args.clientName} — ${visit} (ordered by ${args.orderedBy}) ` +
      `AFTER it was ordered/charged; test(s) cancelled before reaching the lab: ${testList}`,
  });
}

/**
 * Keeps a visit's lab order (BloodSample, 1:1 with the consultation) in step with
 * the current draft — the fix for the phantom-order dead-end (F#4). Called on
 * every consultation save:
 *   - no order yet + collection wanted  → create it (audited as "Ordered blood work")
 *   - pending order, test list changed  → update its tests in place
 *   - pending order, collection removed → cancel (delete) it
 * Any test dropped off a still-pending order is written to the audit log as a
 * billed-then-cancelled accountability event (see writeBloodTestRemovalAuditTx).
 *
 * A sample that has already been sent to the lab (`sentAt`) or has results
 * (`receivedAt`) is a real in-progress record: we never silently rewrite or delete
 * it. If the draft edit wouldn't change its tests we leave it untouched; if it
 * would remove/alter them we refuse the whole save so the consultation and the lab
 * can't diverge — the dietitian must coordinate with the secretary instead.
 */
export async function reconcileVisitBloodSampleTx(
  tx: Prisma.TransactionClient,
  input: {
    clientId: string;
    dietitianId?: string | null;
    consultationId: string;
    wantCollection: boolean;
    tests: string[];
  },
  actor?: { name?: string | null; email?: string | null },
): Promise<void> {
  const desiredTests = input.tests;
  const desiredSet = new Set(desiredTests);
  const existing = await tx.bloodSample.findUnique({
    where: { consultationId: input.consultationId },
    include: { client: true, consultation: { select: { visitNumber: true } } },
  });

  // No lab order yet: create one when the draft now asks for a collection.
  if (!existing) {
    if (input.wantCollection && desiredTests.length > 0) {
      await createBloodSampleTx(tx, {
        clientId: input.clientId,
        dietitianId: input.dietitianId ?? null,
        consultationId: input.consultationId,
        tests: desiredTests,
        orderedAt: new Date(),
      });
    }
    return;
  }

  const currentTests = parseTests(existing.tests);
  const wantsSameOrder =
    input.wantCollection && desiredTests.length > 0 && sameTests(currentTests, desiredTests);

  // Already at the lab / results in — a real in-progress record. Leave it alone
  // when nothing about the tests changed; otherwise refuse the save rather than
  // silently destroy or diverge from lab state.
  if (existing.sentAt || existing.receivedAt) {
    if (!wantsSameOrder) {
      throw new ConflictError(
        "A blood test on this visit was already sent to the lab and can't be changed or removed here — coordinate with the secretary.",
      );
    }
    return;
  }

  // Still pending — reconcile it to the draft. Re-saving the same order is a no-op.
  if (wantsSameOrder) return;

  const clientName = `${existing.client.firstName} ${existing.client.lastName}`;
  const orderedBy = existing.dietitianName ?? "Unassigned";

  if (!input.wantCollection || desiredTests.length === 0) {
    // Collection removed entirely before anything left for the lab → cancel it.
    await writeBloodTestRemovalAuditTx(tx, {
      clientName,
      visitNumber: existing.consultation?.visitNumber ?? null,
      orderedBy,
      removedTests: currentTests,
      cancelled: true,
      actor,
    });
    await tx.bloodSample.delete({ where: { consultationId: input.consultationId } });
    return;
  }

  // Collection kept but the test list changed → update the pending order in place.
  // Any dropped test is a billed-then-cancelled event and is audited.
  const removedTests = currentTests.filter((t) => !desiredSet.has(t));
  if (removedTests.length > 0) {
    await writeBloodTestRemovalAuditTx(tx, {
      clientName,
      visitNumber: existing.consultation?.visitNumber ?? null,
      orderedBy,
      removedTests,
      cancelled: false,
      actor,
    });
  }
  await tx.bloodSample.update({
    where: { consultationId: input.consultationId },
    data: { tests: JSON.stringify(desiredTests) },
  });
}

export async function listBloodSamples(
  opts: { clientId?: string } = {},
): Promise<BloodSample[]> {
  const rows = await db.bloodSample.findMany({
    where: { clientId: opts.clientId },
    include,
    orderBy: { orderedAt: "desc" },
  });
  return rows.map(toBloodSample);
}

export async function getBloodSample(id: string): Promise<BloodSample | null> {
  const row = await db.bloodSample.findUnique({ where: { id }, include });
  return row ? toBloodSample(row) : null;
}

async function getBloodSampleOrThrow(id: string): Promise<BloodSample> {
  const sample = await getBloodSample(id);
  if (!sample) throw new NotFoundError("Blood sample not found");
  return sample;
}

/**
 * Secretary updates a sample: advance it (send → receive), undo a step, or edit
 * a recorded time / note. Timestamps are server-authoritative — an action with
 * no `at` stamps the current time. Transitions are guarded so the data stays
 * honest: results can't be logged before the sample was sent, a send can't be
 * undone once results exist (that would silently destroy them), and a received
 * time can never predate the send. Every state change is written to the audit
 * log and attributed to the acting user, the same way expenses/payments are.
 */
export async function updateBloodSample(
  id: string,
  input: {
    action?: "send" | "receive" | "unsend" | "unreceive";
    at?: string;
    notes?: string | null;
  },
  actor?: SampleActor,
): Promise<BloodSample> {
  const userId = await userIdByEmail(actor?.email);

  await db.$transaction(async (tx) => {
    const existing = await tx.bloodSample.findUnique({ where: { id }, include });
    if (!existing) throw new NotFoundError("Blood sample not found");

    const clientName = `${existing.client.firstName} ${existing.client.lastName}`;
    const data: Prisma.BloodSampleUpdateManyMutationInput = {};
    // Each meaningful change appends one audit event so a state change is never
    // silent and is always attributable to the acting user (mirrors expenses).
    const events: { action: string; label: string }[] = [];

    // Effective timestamps AFTER this update — used to guard their ordering.
    let nextSent: Date | null = existing.sentAt;
    let nextReceived: Date | null = existing.receivedAt;

    // Resolves a caller-supplied send/receive time (or "now"), rejecting values
    // that fall outside sane bounds. The server — not just the UI — is the guard.
    const stampedAt = (): Date => {
      const parsed = input.at ? new Date(input.at) : null;
      const value = parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date();
      const t = value.getTime();
      if (t > Date.now() + MAX_FUTURE_MS) {
        throw new ConflictError("Timestamp can't be in the future.");
      }
      if (t < EARLIEST_SAMPLE_TS) {
        throw new ConflictError("Timestamp is unreasonably far in the past.");
      }
      return value;
    };

    switch (input.action) {
      case "send": {
        const at = stampedAt();
        data.sentAt = at;
        nextSent = at;
        events.push(
          existing.sentAt
            ? { action: "Edited blood sample sent time", label: `${clientName} — sent time ${auditTime(existing.sentAt)} → ${auditTime(at)}` }
            : { action: "Sent blood sample to lab", label: `${clientName} — marked sent (${auditTime(at)})` },
        );
        break;
      }
      case "receive": {
        if (!existing.sentAt) {
          throw new ConflictError("Mark the sample as sent before logging results.");
        }
        const at = stampedAt();
        data.receivedAt = at;
        nextReceived = at;
        events.push(
          existing.receivedAt
            ? { action: "Edited blood results time", label: `${clientName} — results time ${auditTime(existing.receivedAt)} → ${auditTime(at)}` }
            : { action: "Logged blood results received", label: `${clientName} — results received (${auditTime(at)})` },
        );
        break;
      }
      case "unsend": {
        // Undoing "sent" clears the send stamp. If results are already recorded,
        // clearing here would silently destroy them — refuse, and require the
        // results to be undone first (the UI already hides this once results exist).
        if (existing.receivedAt) {
          throw new ConflictError(
            "Results are already recorded — undo the results before undoing the send.",
          );
        }
        data.sentAt = null;
        data.receivedAt = null;
        nextSent = null;
        nextReceived = null;
        events.push({ action: "Reverted blood sample to awaiting-send", label: `${clientName} — send undone` });
        break;
      }
      case "unreceive": {
        data.receivedAt = null;
        nextReceived = null;
        events.push({ action: "Reopened blood sample (results not in)", label: `${clientName} — results undone` });
        break;
      }
    }

    if (input.notes !== undefined) {
      const trimmed = input.notes?.trim();
      const next = trimmed ? trimmed : null;
      if ((existing.notes ?? null) !== next) {
        data.notes = next;
        events.push({
          action: "Edited blood sample note",
          label: `${clientName} — note "${existing.notes ?? "empty"}" → "${next ?? "empty"}"`,
        });
      }
    }

    // Results can never predate the send — covers "receive earlier than sent" and
    // "edit the sent time to after the results were already in".
    if (nextSent && nextReceived && nextReceived.getTime() < nextSent.getTime()) {
      throw new ConflictError("Results time can't be before the sample was sent.");
    }

    // Conditional update guarded on the sample still being in the state we read
    // (both timestamps unchanged). If someone else advanced or undid a step in
    // the meantime this matches zero rows and we throw, rolling back this tx —
    // so the loser of a concurrent edit gets a clear error instead of silently
    // clobbering the winner. Mirrors the debt-clearing guard in clientDebts.ts.
    const guarded = await tx.bloodSample.updateMany({
      where: { id, sentAt: existing.sentAt, receivedAt: existing.receivedAt },
      data,
    });
    if (guarded.count === 0) {
      throw new ConflictError(
        "This sample was just changed by someone else — reload and try again.",
      );
    }
    for (const e of events) {
      await writeAudit(tx, {
        userId,
        userName: actor?.name,
        action: e.action,
        entityType: "BloodSample",
        entityLabel: e.label,
      });
    }
  });

  return getBloodSampleOrThrow(id);
}
