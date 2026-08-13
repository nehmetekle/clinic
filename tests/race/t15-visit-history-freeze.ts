/**
 * Closed visits are historical records: the names they display must not change
 * when the underlying staff/bundle records are renamed later. Test DB only.
 *
 * Covers both close paths (createConsultation({close:true}) and
 * closeConsultation), and asserts an open draft deliberately stays live.
 */
import { db } from "@/server/db";
import {
  closeConsultation,
  consultationInclude,
  createConsultation,
  toConsultation,
} from "@/server/repositories/consultations";
import { listVisitBaskets, settleVisitBasket } from "@/server/repositories/visitBaskets";

/** Re-reads a visit through the exact mapper the API/UI uses. */
async function readVisit(id: string) {
  const row = await db.consultation.findUniqueOrThrow({ where: { id }, include: consultationInclude });
  return toConsultation(row);
}

const ok = (label: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) process.exitCode = 1;
};

async function main() {
  await db.auditLog.deleteMany({});
  // PRE-EXISTING harness bug: this reset deleted payments without first clearing
  // the Jessy ledger, so whenever t14 ran immediately before it (which the
  // alphabetical t14 -> t15 order guarantees) the protect_jessy_ledger trigger
  // refused the delete and this whole file aborted before its first assertion.
  // TRUNCATE is the sanctioned ledger reset — see harness.ts resetJessyLedger.
  await db.$executeRawUnsafe(
    `TRUNCATE TABLE "JessySettlement", "JessyReceivable", "JessySettlementAllocation" CASCADE`,
  );
  await db.payment.deleteMany({});
  await db.consultation.deleteMany({});
  await db.clientPackage.deleteMany({});
  await db.client.deleteMany({});
  await db.user.deleteMany({});
  await db.servicePrice.deleteMany({});
  await db.package.deleteMany({});

  const doc = await db.user.create({
    data: {
      fullName: "Dr Original",
      email: "freeze@test.local",
      role: "dietitian",
      passwordHash: "x",
      consultationFee: 0,
    },
  });
  const client = await db.client.create({
    data: { firstName: "Hist", lastName: "Ory", phone: "+96170123456" },
  });
  await db.servicePrice.create({
    data: { kind: "treatment", key: "Cryolipolysis", name: "Cryolipolysis", price: 10, currency: "USD", active: true },
  });
  const pkg = await db.package.create({
    data: { name: "Original Bundle", price: 140, sessions: 15, machine: "Cryolipolysis", currency: "USD" },
  });

  // ---- 1. Close path A: closeConsultation on a saved draft.
  const v1 = await createConsultation({
    clientId: client.id,
    dietitianId: doc.id,
    weightKg: 60,
    treatments: [
      { machine: "Cryolipolysis", sessionsNeeded: 15, sessionsUsed: 1, applyPackageId: pkg.id },
    ],
  });

  // While OPEN the draft reads live names — a mid-visit correction should land.
  const openView = await readVisit(v1.id);
  ok("open draft reads the live dietitian name", openView.dietitianName === "Dr Original",
     `got ${openView.dietitianName}`);
  const openRow = await db.consultation.findUniqueOrThrow({ where: { id: v1.id } });
  ok("open draft has NO frozen name", openRow.dietitianNameSnapshot === null,
     `got ${openRow.dietitianNameSnapshot}`);

  // Settle whatever the bundle raised, so the visit is closeable.
  for (const b of await listVisitBaskets({ clientId: client.id, status: "pending" })) {
    await settleVisitBasket(b.id, { splits: [{ method: "cash", amount: b.total }], actorName: "Sec" });
  }
  await closeConsultation(v1.id, { actorName: "Sec" });

  const closedRow = await db.consultation.findUniqueOrThrow({ where: { id: v1.id } });
  ok("closeConsultation freezes the dietitian name",
     closedRow.dietitianNameSnapshot === "Dr Original", `got ${closedRow.dietitianNameSnapshot}`);
  const closedTreatments = await db.consultationTreatment.findMany({ where: { consultationId: v1.id } });
  ok("closeConsultation freezes the bundle name",
     closedTreatments.every((t) => t.packageNameSnapshot === "Original Bundle"),
     `got ${closedTreatments.map((t) => t.packageNameSnapshot).join("|")}`);

  // ---- 2. Rename everything, then re-read the closed visit.
  await db.user.update({ where: { id: doc.id }, data: { fullName: "Dr RENAMED" } });
  await db.clientPackage.updateMany({ data: { packageName: "RENAMED Bundle" } });
  await db.package.update({ where: { id: pkg.id }, data: { name: "RENAMED Catalog" } });

  const after = await readVisit(v1.id);
  ok("closed visit still shows the ORIGINAL dietitian", after.dietitianName === "Dr Original",
     `got ${after.dietitianName}`);
  ok("closed visit still shows the ORIGINAL bundle name",
     (after.treatments ?? []).every((t) => t.packageName === "Original Bundle"),
     `got ${(after.treatments ?? []).map((t) => t.packageName).join("|")}`);

  // ---- 3. Close path B: createConsultation({ close: true }).
  const doc2 = await db.user.create({
    data: { fullName: "Dr Second", email: "freeze2@test.local", role: "dietitian", passwordHash: "x", consultationFee: 0 },
  });
  const v2 = await createConsultation(
    { clientId: client.id, dietitianId: doc2.id, weightKg: 58, notes: "no charges" },
    { close: true, actorName: "Sec" },
  );
  const v2Row = await db.consultation.findUniqueOrThrow({ where: { id: v2.id } });
  ok("createConsultation({close:true}) closed the visit", v2Row.status === "closed", v2Row.status);
  ok("createConsultation({close:true}) freezes the dietitian name",
     v2Row.dietitianNameSnapshot === "Dr Second", `got ${v2Row.dietitianNameSnapshot}`);

  await db.user.update({ where: { id: doc2.id }, data: { fullName: "Dr Second RENAMED" } });
  const v2After = await readVisit(v2.id);
  ok("visit closed on create ignores the later rename", v2After.dietitianName === "Dr Second",
     `got ${v2After.dietitianName}`);

  // The patient now weighs 58 kg (visit 2) but visit 1 must still read 60 kg.
  const v1Again = await readVisit(v1.id);
  ok("visit 1 keeps its own weight after a later, lighter visit",
     v1Again.weightKg === 60 && v2After.weightKg === 58,
     `v1=${v1Again.weightKg} v2=${v2After.weightKg}`);

  // ---- 4. A pre-migration closed visit (no snapshot) still resolves a name.
  await db.consultation.update({
    where: { id: v2.id },
    data: { dietitianNameSnapshot: null },
  });
  const legacy = await readVisit(v2.id);
  ok("legacy closed visit falls back to the live relation",
     legacy.dietitianName === "Dr Second RENAMED", `got ${legacy.dietitianName}`);

  await db.$disconnect();
}

main();
