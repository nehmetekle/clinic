/**
 * Referrer reassignment: attribution follows `referralSource` right up until a
 * commission is incurred (the patient's first completed visit), then freezes.
 * Test DB only (see run.sh).
 *
 * Covers:
 *  - a referrer added AFTER registration (walked in, none picked) is attributed
 *    before any visit happens
 *  - reassigning to a different referrer before the first visit re-targets
 *    attribution again
 *  - once the first visit closes and incurs a commission, further referrer
 *    edits change the display text (`referralSource`) but do NOT move the
 *    commission or the frozen attribution
 *  - the commission amount is still the rate in force at the moment it was
 *    incurred, from whichever referrer was attributed at that instant
 */
import { db } from "@/server/db";
import { createClient, updateClient } from "@/server/repositories/clients";
import { createReferrer } from "@/server/repositories/referrers";
import { createConsultation, closeConsultation } from "@/server/repositories/consultations";

const ok = (label: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) process.exitCode = 1;
};

async function reset() {
  await db.auditLog.deleteMany({});
  await db.referralCommission.deleteMany({});
  // Machine visits reference session plans with a RESTRICT foreign key, and
  // session plans belong to a client — both must go before the client cascade
  // reaches them (shared DB with the other race tests; see t19's reset).
  await db.machineVisit.deleteMany({});
  await db.sessionPlan.deleteMany({});
  await db.visitBasket.deleteMany({});
  await db.consultation.deleteMany({});
  await db.client.deleteMany({});
  await db.user.deleteMany({});
  await db.referrer.deleteMany({});
}

async function main() {
  await reset();

  const dietitian = await db.user.create({
    data: { fullName: "Dr Test", email: "doctor@t22.local", role: "dietitian", passwordHash: "x" },
  });
  const referrerA = await createReferrer({ name: "Referrer A", fee: 20, active: true });
  const referrerB = await createReferrer({ name: "Referrer B", fee: 35, active: true });

  // --- 1. Walk-in, no referrer at registration ---
  let client = await createClient({
    firstName: "T22",
    lastName: "Patient",
    phone: "+96170220001",
    confirmDuplicatePhone: true,
  });
  ok("no referrer at registration", client.referralSource == null || client.referralSource === "");

  // --- 2. Front desk notices later, before any visit: add Referrer A ---
  client = await updateClient(client.id, { referralSource: "Referrer A" }, "secretary");
  let row = await db.client.findUniqueOrThrow({ where: { id: client.id } });
  ok(
    "attribution set to Referrer A pre-visit",
    row.referrerId === referrerA.id && row.referrerNameSnapshot === "Referrer A",
  );

  // --- 3. Changed their mind before any visit: reassign to Referrer B ---
  client = await updateClient(client.id, { referralSource: "Referrer B" }, "secretary");
  row = await db.client.findUniqueOrThrow({ where: { id: client.id } });
  ok(
    "attribution re-targeted to Referrer B pre-visit",
    row.referrerId === referrerB.id && row.referrerNameSnapshot === "Referrer B",
  );

  // --- 4. First visit completes: commission incurred against whoever is
  //     attributed NOW (Referrer B), at Referrer B's current rate ---
  const consult = await createConsultation({
    clientId: client.id,
    dietitianId: dietitian.id,
  });
  await closeConsultation(consult.id, { actorName: "Dr Test" });

  const commission = await db.referralCommission.findUnique({ where: { clientId: client.id } });
  ok(
    "commission incurred against Referrer B at $35",
    !!commission && commission.referrerId === referrerB.id && commission.amount === 35,
    commission ? `got referrerId=${commission.referrerId} amount=${commission.amount}` : "no commission row",
  );

  // --- 5. Referrer B's live rate changes afterwards: must not reprice the
  //     already-incurred commission ---
  await db.referrer.update({ where: { id: referrerB.id }, data: { fee: 999 } });
  const afterRateChange = await db.referralCommission.findUnique({ where: { clientId: client.id } });
  ok("incurred commission amount stays frozen at $35", afterRateChange?.amount === 35);

  // --- 6. Attempt to reassign referrer AFTER the commission was incurred:
  //     text may change, attribution and commission must NOT move ---
  client = await updateClient(client.id, { referralSource: "Referrer A" }, "secretary");
  row = await db.client.findUniqueOrThrow({ where: { id: client.id } });
  ok(
    "referralSource text updates post-commission",
    row.referralSource === "Referrer A",
  );
  ok(
    "frozen attribution stays Referrer B post-commission",
    row.referrerId === referrerB.id && row.referrerNameSnapshot === "Referrer B",
  );
  const commissionAfter = await db.referralCommission.findUnique({ where: { clientId: client.id } });
  ok(
    "commission still owed to Referrer B, unmoved and unrepriced",
    commissionAfter?.referrerId === referrerB.id && commissionAfter?.amount === 35,
  );

  // --- 7. Audit trail records the post-commission edit as text-only ---
  const auditLine = await db.auditLog.findFirst({
    where: { action: "Changed patient referrer" },
    orderBy: { createdAt: "desc" },
  });
  ok(
    "audit line notes commission stayed put",
    !!auditLine && /already incurred/.test(auditLine.entityLabel ?? ""),
    auditLine?.entityLabel ?? "no audit line",
  );

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
