/**
 * Shared fixtures for the Food List PDF race tests. Runs against a throwaway
 * `nutriclinic_test` database (never the dev DB) — see run.sh.
 */
import { db } from "../../src/server/db";

export const ACTOR = { name: "Dr Test", email: "doctor@test.local" };

/**
 * Wipes the Jessy ledger. The ledger is protected by database triggers that
 * refuse to delete a settled receivable, a transfer, or an allocation (see the
 * protect_jessy_ledger migration) — deliberately, because those deletes would
 * corrupt the outstanding balance. TRUNCATE does not fire row-level triggers,
 * which makes it the one sanctioned way to reset a protected ledger, and it must
 * run BEFORE any client/payment delete, whose cascade would otherwise be blocked.
 */
export async function resetJessyLedger() {
  await db.$executeRawUnsafe(
    `TRUNCATE TABLE "JessySettlement", "JessyReceivable", "JessySettlementAllocation" CASCADE`,
  );
}

export async function resetDb() {
  // Order matters only for tables without cascade from Client/User.
  await db.auditLog.deleteMany({});
  await db.consultationFile.deleteMany({});
  await resetJessyLedger();
  // Machine visits reference session plans/bundles with RESTRICT foreign keys, so
  // they must go before the client cascade would try to remove those rows.
  await db.machineVisit.deleteMany({});
  await db.consultation.deleteMany({});
  await db.client.deleteMany({});
  await db.user.deleteMany({});
}

export async function makeDoctor() {
  return db.user.create({
    data: {
      fullName: ACTOR.name,
      email: ACTOR.email,
      role: "dietitian",
      passwordHash: "x",
    },
  });
}

export async function makeClient() {
  return db.client.create({
    data: { firstName: "Race", lastName: "Patient", phone: "+96170123456" },
  });
}

/** A saved open visit with a filled-in Food List (3 ticks). */
export async function makeConsultationWithFoodList(clientId: string, dietitianId: string) {
  const c = await db.consultation.create({
    data: { clientId, dietitianId, date: new Date(), visitNumber: 1, status: "open" },
  });
  await db.consultationFoodList.create({
    data: {
      consultationId: c.id,
      language: "en",
      patientName: "Race Patient",
      selections: JSON.stringify(["vegetables.artichoke", "fruits.apple", "eggs-and-dairy.cows-milk"]),
    },
  });
  return c;
}

export function ok(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) process.exitCode = 1;
}

export function info(label: string) {
  console.log(`  ..    ${label}`);
}
