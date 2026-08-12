/**
 * Jessy (third-party payer) accounting, end to end. Test DB only (see run.sh).
 *
 * The rule under test: money a patient pays through Jessy is income the moment
 * the visit is settled — it is NOT deferred until Jessy transfers it — while
 * Jessy separately owes the clinic that amount. A later transfer from Jessy
 * therefore clears a receivable and must NEVER be counted as income again.
 *
 * Also locks in that Jessy leaves the existing money paths untouched: patient
 * debt, the card surcharge, split settlements and the method breakdown.
 */
import { db } from "@/server/db";
import { getJessySummary, recordJessySettlement } from "@/server/repositories/jessy";
import { createPayment } from "@/server/repositories/payments";
import { upsertPendingBasketTx, settleVisitBasket } from "@/server/repositories/visitBaskets";
import { getDashboardSummaryForRole } from "@/server/services/dashboard";
import { clearClientDebt } from "@/server/repositories/clientDebts";
import { deleteConsultation } from "@/server/repositories/consultations";
import { createSession, SESSION_COOKIE_NAME } from "@/server/session";
import { handleError } from "@/server/http";
import { resetJessyLedger } from "./harness";

const ok = (label: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) process.exitCode = 1;
};
const money = (n: number) => Math.round(n * 100) / 100;

let doc: { id: string };

async function reset() {
  await db.auditLog.deleteMany({});
  // The ledger is trigger-protected against deletes; TRUNCATE is the sanctioned
  // reset and must precede the payment/client wipes its cascade would block.
  await resetJessyLedger();
  await db.payment.deleteMany({});
  await db.visitBasket.deleteMany({});
  await db.consultation.deleteMany({});
  await db.client.deleteMany({});
  await db.user.deleteMany({});
  doc = await db.user.create({
    data: { fullName: "Dr J", email: "j@test.local", role: "dietitian", passwordHash: "x", consultationFee: 0 },
  });
}

/** A patient with an open visit and a pending basket of `total` USD. */
async function makeVisit(name: string, total: number) {
  const client = await db.client.create({
    data: { firstName: name, lastName: "Test", phone: "+96170123456" },
  });
  const consultation = await db.consultation.create({
    data: { clientId: client.id, dietitianId: doc.id, date: new Date(), visitNumber: 1, status: "open" },
  });
  const basketId = await db.$transaction((tx) =>
    upsertPendingBasketTx(tx, {
      clientId: client.id,
      dietitianId: doc.id,
      consultationId: consultation.id,
      items: [{ kind: "custom", label: "Visit charges", quantity: 1, unitPrice: total }],
    }),
  );
  return { client, consultation, basketId: basketId as string };
}

/** Income by payment method, straight from the admin dashboard/report figures. */
async function reportedIncome() {
  const d = await getDashboardSummaryForRole({ role: "admin" });
  return {
    total: money(d.finance.totalIncome),
    byMethod: Object.fromEntries(
      Object.entries(d.finance.incomeByMethod).map(([k, v]) => [k, money(v)]),
    ) as Record<string, number>,
    jessyOutstanding: money(d.finance.jessyOutstanding),
  };
}

async function outstandingDebt(clientId: string) {
  const rows = await db.clientDebt.findMany({ where: { clientId, status: "outstanding" } });
  return money(rows.reduce((s, d) => s + d.amount, 0));
}

async function main() {
  // ---- 1. Basic flow: $600 visit, $400 through Jessy, $200 left owed
  await reset();
  {
    const { client, basketId } = await makeVisit("Basic", 600);
    await settleVisitBasket(basketId, {
      splits: [{ method: "jessy", amount: 400 }],
      debtAmount: 200,
      debtReason: "Balance still owed",
      actorName: "Sec",
    });

    const payments = await db.payment.findMany({ where: { clientId: client.id } });
    ok("a normal $400 payment exists with method jessy",
       payments.length === 1 && payments[0].method === "jessy" && payments[0].amountPaid === 400,
       `${payments.length} payment(s): ${payments.map((p) => `${p.method} ${p.amountPaid}`).join(", ")}`);

    const income = await reportedIncome();
    ok("the $400 counts as income immediately", income.total === 400, `got ${income.total}`);
    ok("income breakdown attributes $400 to Jessy", income.byMethod.jessy === 400,
       JSON.stringify(income.byMethod));

    ok("patient debt is $200 (not $600, not $400)", (await outstandingDebt(client.id)) === 200,
       `got ${await outstandingDebt(client.id)}`);

    const recv = await db.jessyReceivable.findMany({ where: { clientId: client.id } });
    ok("one $400 Jessy receivable exists", recv.length === 1 && recv[0].amount === 400 && recv[0].remaining === 400,
       `${recv.length}: ${recv.map((r) => `${r.amount}/${r.remaining}`).join(", ")}`);
    ok("the receivable is traceable to the visit", recv[0]?.consultationId !== null);
    ok("Jessy outstanding reports $400", income.jessyOutstanding === 400, `got ${income.jessyOutstanding}`);
    ok("no Jessy amount leaked into patient debt",
       (await db.clientDebt.count({ where: { clientId: client.id, amount: 400 } })) === 0);
  }

  // ---- 2. Fully paid through Jessy: patient owes nothing, Jessy owes it all
  await reset();
  {
    const { client, basketId } = await makeVisit("Full", 600);
    await settleVisitBasket(basketId, { splits: [{ method: "jessy", amount: 600 }], actorName: "Sec" });

    ok("patient owes $0", (await outstandingDebt(client.id)) === 0);
    const summary = await getJessySummary();
    ok("Jessy outstanding = $600", summary.outstanding === 600, `got ${summary.outstanding}`);
    const income = await reportedIncome();
    ok("income includes the full $600 immediately", income.total === 600, `got ${income.total}`);
    ok("breakdown shows Jessy $600", income.byMethod.jessy === 600, JSON.stringify(income.byMethod));
  }

  // ---- 3. Split settlement: $100 cash + $300 Jessy + $200 patient debt
  await reset();
  {
    const { client, basketId } = await makeVisit("Split", 600);
    await settleVisitBasket(basketId, {
      splits: [{ method: "cash", amount: 100 }, { method: "jessy", amount: 300 }],
      debtAmount: 200,
      debtReason: "Remainder",
      actorName: "Sec",
    });

    const income = await reportedIncome();
    ok("cash reports $100", income.byMethod.cash === 100, JSON.stringify(income.byMethod));
    ok("Jessy reports $300", income.byMethod.jessy === 300, JSON.stringify(income.byMethod));
    ok("patient debt is $200", (await outstandingDebt(client.id)) === 200);
    ok("Jessy outstanding = $300", (await getJessySummary()).outstanding === 300);
    ok("only the Jessy portion created a receivable",
       (await db.jessyReceivable.count()) === 1);
  }

  // ---- 4. Settlements: partial, then the remainder. Never new income.
  await reset();
  {
    const { basketId } = await makeVisit("Settle", 400);
    await settleVisitBasket(basketId, { splits: [{ method: "jessy", amount: 400 }], actorName: "Sec" });

    const incomeBefore = await reportedIncome();
    const paymentsBefore = await db.payment.count();

    await recordJessySettlement({ amount: 250, reference: "TRF-1", recordedByName: "Admin" });
    let summary = await getJessySummary();
    ok("outstanding drops to $150 after a $250 transfer", summary.outstanding === 150, `got ${summary.outstanding}`);
    ok("settled total is $250", summary.settled === 250, `got ${summary.settled}`);
    ok("recorded (income volume) is unchanged at $400", summary.recorded === 400, `got ${summary.recorded}`);

    const incomeAfter = await reportedIncome();
    ok("the $250 created NO extra income", incomeAfter.total === incomeBefore.total,
       `${incomeBefore.total} -> ${incomeAfter.total}`);
    ok("the $250 created NO extra payment row", (await db.payment.count()) === paymentsBefore,
       `${paymentsBefore} -> ${await db.payment.count()}`);
    ok("reported Jessy outstanding follows the ledger", incomeAfter.jessyOutstanding === 150,
       `got ${incomeAfter.jessyOutstanding}`);

    const alloc = await db.jessySettlementAllocation.findMany();
    ok("the settlement is allocated to the receivable", alloc.length === 1 && alloc[0].amount === 250,
       `${alloc.length} allocation(s)`);
    ok("the settlement appears in the audit log",
       (await db.auditLog.count({ where: { action: "Jessy settlement recorded" } })) === 1);
    ok("the Jessy payment itself was audited",
       (await db.auditLog.count({ where: { action: "Jessy payment recorded" } })) === 1);

    // Remainder
    await recordJessySettlement({ amount: 150, recordedByName: "Admin" });
    summary = await getJessySummary();
    ok("outstanding reaches $0", summary.outstanding === 0, `got ${summary.outstanding}`);
    ok("settled total is $400", summary.settled === 400, `got ${summary.settled}`);
    ok("still no duplicate income", (await reportedIncome()).total === incomeBefore.total);
    const recv = await db.jessyReceivable.findFirstOrThrow();
    ok("the fully-paid receivable is marked settled", recv.status === "settled" && recv.remaining === 0,
       `${recv.status} remaining=${recv.remaining}`);
  }

  // ---- 5. Over-settlement is refused, balances untouched
  await reset();
  {
    const { basketId } = await makeVisit("Over", 150);
    await settleVisitBasket(basketId, { splits: [{ method: "jessy", amount: 150 }], actorName: "Sec" });

    let refused = "";
    try {
      await recordJessySettlement({ amount: 200, recordedByName: "Admin" });
    } catch (e) { refused = (e as Error).message; }
    ok("settling $200 against $150 is rejected", refused.includes("only owes"), refused || "no error thrown");

    const summary = await getJessySummary();
    ok("outstanding is still $150", summary.outstanding === 150, `got ${summary.outstanding}`);
    ok("nothing was settled", summary.settled === 0, `got ${summary.settled}`);
    ok("no settlement row was left behind", (await db.jessySettlement.count()) === 0);

    // The last line of defence: even a direct write that bypasses the repository
    // cannot drive a balance negative — Postgres rejects it.
    const row = await db.jessyReceivable.findFirstOrThrow();
    let dbBlocked = false;
    try {
      await db.jessyReceivable.update({ where: { id: row.id }, data: { remaining: -1 } });
    } catch { dbBlocked = true; }
    ok("the DB itself refuses a negative remaining balance", dbBlocked);
    let aboveBlocked = false;
    try {
      await db.jessyReceivable.update({ where: { id: row.id }, data: { remaining: row.amount + 1 } });
    } catch { aboveBlocked = true; }
    ok("the DB refuses a balance above the original amount", aboveBlocked);
    ok("the balance is untouched after both attempts",
       (await getJessySummary()).outstanding === 150);
  }

  // ---- 6. Concurrency: two settlements racing the same balance
  await reset();
  {
    const { basketId } = await makeVisit("Race", 100);
    await settleVisitBasket(basketId, { splits: [{ method: "jessy", amount: 100 }], actorName: "Sec" });

    // Both ask for the full remaining balance at the same time.
    const results = await Promise.allSettled([
      recordJessySettlement({ amount: 100, reference: "A", recordedByName: "Admin" }),
      recordJessySettlement({ amount: 100, reference: "B", recordedByName: "Admin" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];

    ok("exactly one of the two settlements succeeds", fulfilled === 1, `${fulfilled} succeeded`);
    const summary = await getJessySummary();
    ok("outstanding is $0, never negative", summary.outstanding === 0, `got ${summary.outstanding}`);
    ok("only $100 was settled in total", summary.settled === 100, `got ${summary.settled}`);
    ok("only one settlement row exists", (await db.jessySettlement.count()) === 1);
    // The loser must fail with a readable message, not a raw Postgres/Prisma error.
    const msg = rejected[0]?.reason?.message ?? "";
    ok("the loser gets an understandable message, not a DB error",
       /only owes|at the same time/.test(msg) && !/prisma|constraint|P20\d\d/i.test(msg),
       msg || "no rejection");

    // A double-submitted transfer (same idempotency key) must apply once only.
    await reset();
    const v = await makeVisit("Dup", 100);
    await settleVisitBasket(v.basketId, { splits: [{ method: "jessy", amount: 100 }], actorName: "Sec" });
    await recordJessySettlement({ amount: 40, idempotencyKey: "dup-key", recordedByName: "Admin" });
    await recordJessySettlement({ amount: 40, idempotencyKey: "dup-key", recordedByName: "Admin" });
    const dup = await getJessySummary();
    ok("a repeated settlement key settles only once", dup.settled === 40 && dup.outstanding === 60,
       `settled=${dup.settled} outstanding=${dup.outstanding}`);
  }

  // ---- 7. Double-submitted Jessy PAYMENT creates only one receivable
  await reset();
  {
    const client = await db.client.create({
      data: { firstName: "Double", lastName: "Click", phone: "+96170123456" },
    });
    const body = {
      clientId: client.id, motif: "Visit", amountPaid: 300,
      method: "jessy", idempotencyKey: "same-key", actorName: "Sec",
    };
    const first = await createPayment(body);
    const second = await createPayment(body);

    ok("the resubmit returns the same payment", first.id === second.id);
    ok("only one payment row exists", (await db.payment.count()) === 1);
    ok("only ONE Jessy receivable was created", (await db.jessyReceivable.count()) === 1,
       `got ${await db.jessyReceivable.count()}`);
    ok("Jessy outstanding is $300, not $600", (await getJessySummary()).outstanding === 300);

    // Concurrent double-submit (same key, at once) must behave identically.
    await db.payment.deleteMany({});
    await Promise.allSettled([
      createPayment({ ...body, idempotencyKey: "race-key" }),
      createPayment({ ...body, idempotencyKey: "race-key" }),
    ]);
    ok("a concurrent double-submit also yields one receivable",
       (await db.jessyReceivable.count()) === 1, `got ${await db.jessyReceivable.count()}`);
  }

  // ---- 8. Regressions: the other methods, card surcharge, debt clearing
  await reset();
  {
    await db.setting.upsert({
      where: { key: "cardSurchargePercent" },
      create: { key: "cardSurchargePercent", value: "10" },
      update: { value: "10" },
    });

    const { client, basketId } = await makeVisit("Regress", 400);
    await settleVisitBasket(basketId, {
      splits: [
        { method: "cash", amount: 100 },
        { method: "card", amount: 100 },
        { method: "whish", amount: 100 },
        { method: "omt", amount: 100 },
      ],
      actorName: "Sec",
    });

    const income = await reportedIncome();
    ok("cash still reports $100", income.byMethod.cash === 100, JSON.stringify(income.byMethod));
    ok("card reports $110 (10% surcharge still applied)", income.byMethod.card === 110,
       JSON.stringify(income.byMethod));
    ok("whish still reports $100", income.byMethod.whish === 100, JSON.stringify(income.byMethod));
    ok("omt still reports $100", income.byMethod.omt === 100, JSON.stringify(income.byMethod));
    ok("a 4-way split created 4 payments", (await db.payment.count()) === 4);
    ok("none of the other methods created a receivable", (await db.jessyReceivable.count()) === 0,
       `got ${await db.jessyReceivable.count()}`);

    // Jessy carries NO surcharge even with one configured.
    const jessyPayment = await createPayment({
      clientId: client.id, motif: "Jessy visit", amountPaid: 200, method: "jessy", actorName: "Sec",
    });
    ok("a Jessy payment gets no card surcharge",
       jessyPayment.amountPaid === 200 && jessyPayment.cardSurchargeAmount === 0,
       `paid=${jessyPayment.amountPaid} surcharge=${jessyPayment.cardSurchargeAmount}`);
    ok("its receivable is the full $200", (await getJessySummary()).outstanding === 200);

    // Clearing a patient debt THROUGH Jessy: income lands now, Jessy owes it.
    const debt = await db.clientDebt.create({
      data: { clientId: client.id, amount: 50, currency: "USD", usdToLbp: 90000,
              reason: "Old balance", source: "secretary_override", status: "outstanding" },
    });
    await clearClientDebt(debt.id, { method: "jessy", clearedByName: "Sec" });
    ok("the debt is cleared", (await db.clientDebt.findUniqueOrThrow({ where: { id: debt.id } })).status === "cleared");
    ok("clearing through Jessy adds a $50 receivable", (await getJessySummary()).outstanding === 250,
       `got ${(await getJessySummary()).outstanding}`);

    // Clearing through cash must NOT touch the Jessy ledger.
    const cashDebt = await db.clientDebt.create({
      data: { clientId: client.id, amount: 30, currency: "USD", usdToLbp: 90000,
              reason: "Another balance", source: "secretary_override", status: "outstanding" },
    });
    await clearClientDebt(cashDebt.id, { method: "cash", clearedByName: "Sec" });
    ok("clearing through cash leaves the Jessy ledger alone",
       (await getJessySummary()).outstanding === 250, `got ${(await getJessySummary()).outstanding}`);
  }

  // ---- 9. Atomicity: a failed settlement leaves a payment with no receivable? Never.
  await reset();
  {
    const { basketId } = await makeVisit("Atomic", 500);
    // A split that doesn't add up is rejected AFTER the per-method payments are
    // created inside the transaction — everything must roll back together.
    let refused = "";
    try {
      await settleVisitBasket(basketId, {
        splits: [{ method: "jessy", amount: 300 }],
        actorName: "Sec",
      });
    } catch (e) { refused = (e as Error).message; }
    ok("a split that doesn't add up is rejected", refused.includes("must add up"), refused || "no error");
    ok("no payment survived the rollback", (await db.payment.count()) === 0);
    ok("no orphan receivable survived the rollback", (await db.jessyReceivable.count()) === 0);
    ok("the basket is still pending", (await db.visitBasket.findUniqueOrThrow({ where: { id: basketId } })).status === "pending");
  }

  // ---- 10. The 1:1 invariant holds across a mixed, partly-settled ledger
  await reset();
  {
    // Three Jessy visits plus non-Jessy traffic, then a partial settlement.
    for (const [name, amount] of [["One", 120], ["Two", 80], ["Three", 200]] as const) {
      const v = await makeVisit(name, amount);
      await settleVisitBasket(v.basketId, { splits: [{ method: "jessy", amount }], actorName: "Sec" });
    }
    const cashVisit = await makeVisit("Cash", 75);
    await settleVisitBasket(cashVisit.basketId, { splits: [{ method: "cash", amount: 75 }], actorName: "Sec" });

    const jessyPayments = await db.payment.count({ where: { method: "jessy" } });
    const receivables = await db.jessyReceivable.count();
    ok("every jessy payment has exactly one receivable", jessyPayments === 3 && receivables === 3,
       `${jessyPayments} payment(s) vs ${receivables} receivable(s)`);
    ok("non-jessy payments create none", (await db.payment.count()) === 4);

    // FIFO: $150 clears the oldest ($120) in full and $30 of the next ($80).
    await recordJessySettlement({ amount: 150, recordedByName: "Admin" });
    const rows = await db.jessyReceivable.findMany({ orderBy: { createdAt: "asc" } });
    ok("FIFO clears the oldest receivable first",
       rows[0].remaining === 0 && rows[0].status === "settled",
       `oldest: ${rows[0].remaining} (${rows[0].status})`);
    ok("the next receivable is left part-paid and still outstanding",
       rows[1].remaining === 50 && rows[1].status === "outstanding",
       `second: ${rows[1].remaining} (${rows[1].status})`);
    ok("the newest receivable is untouched", rows[2].remaining === 200, `third: ${rows[2].remaining}`);

    const summary = await getJessySummary();
    ok("outstanding = 400 recorded − 150 settled = 250", summary.outstanding === 250,
       `recorded=${summary.recorded} settled=${summary.settled} outstanding=${summary.outstanding}`);
    // The identity that must always hold across the whole ledger.
    ok("recorded − settled === outstanding",
       money(summary.recorded - summary.settled) === summary.outstanding);
    // And the Jessy income volume is still the full $400, independent of settlement.
    const income = await reportedIncome();
    ok("Jessy income volume stays $400 regardless of settlement", income.byMethod.jessy === 400,
       JSON.stringify(income.byMethod));
    ok("total income counts Jessy + cash once each, never the settlement",
       income.total === 475, `got ${income.total}`);
  }

  // ---- 11. The ledger cannot be corrupted by delete/edit attempts
  await reset();
  {
    const { client, consultation, basketId } = await makeVisit("Protect", 100);
    await settleVisitBasket(basketId, { splits: [{ method: "jessy", amount: 100 }], actorName: "Sec" });
    const payment = await db.payment.findFirstOrThrow();
    const receivable = await db.jessyReceivable.findFirstOrThrow();

    // An UNSETTLED receivable is still disposable with its payment — the guard
    // protects the balance, it doesn't freeze untouched records.
    const before = await getJessySummary();
    ok("an unsettled receivable is not frozen", before.outstanding === 100);

    await recordJessySettlement({ amount: 40, recordedByName: "Admin" });
    const settled = await getJessySummary();

    const blocked = async (label: string, fn: () => Promise<unknown>, expect: RegExp) => {
      let msg = "";
      try { await fn(); } catch (e) { msg = (e as Error).message; }
      ok(label, expect.test(msg), msg ? msg.replace(/\s+/g, " ").slice(0, 90) : "NOT BLOCKED");
    };

    await blocked("deleting a settled Jessy payment is blocked",
      () => db.payment.delete({ where: { id: payment.id } }), /already settled money/);
    await blocked("deleting the patient (cascade) is blocked",
      () => db.client.delete({ where: { id: client.id } }), /already settled money/);
    await blocked("raising a receivable's remaining balance is blocked",
      () => db.jessyReceivable.update({ where: { id: receivable.id }, data: { remaining: 100 } }),
      /can only go down/);
    await blocked("editing a receivable's original amount is blocked",
      () => db.jessyReceivable.update({ where: { id: receivable.id }, data: { amount: 9999 } }),
      /frozen once recorded/);
    await blocked("deleting a recorded transfer is blocked",
      () => db.jessySettlement.deleteMany({}), /permanent and cannot be deleted/);
    await blocked("editing a transfer's amount is blocked",
      () => db.jessySettlement.updateMany({ data: { amount: 5 } }), /frozen and cannot be edited/);
    await blocked("deleting a settlement allocation is blocked",
      () => db.jessySettlementAllocation.deleteMany({}), /permanent audit trail/);
    await blocked("editing a settlement allocation is blocked",
      () => db.jessySettlementAllocation.updateMany({ data: { amount: 1 } }), /permanent audit trail/);
    await blocked("deleting a visit paid through Jessy is blocked",
      () => deleteConsultation(consultation.id, { actorName: "Dr J", actorEmail: "j@test.local", actorRole: "admin" }),
      /paid for and can't be deleted/); // the paid-basket guard fires first

    // The Jessy-specific guard in deleteConsultation is a second line of defence
    // behind that one, so exercise it on its own: a visit carrying a receivable
    // but NO paid basket (not reachable through the UI today — which is exactly
    // why it must not rot silently).
    const bare = await db.consultation.create({
      data: { clientId: client.id, dietitianId: doc.id, date: new Date(), visitNumber: 2, status: "open" },
    });
    await db.jessyReceivable.update({ where: { id: receivable.id }, data: { consultationId: bare.id } });
    await blocked("the Jessy guard alone blocks deleting such a visit",
      () => deleteConsultation(bare.id, { actorName: "Dr J", actorEmail: "j@test.local", actorRole: "admin" }),
      /paid through Jessy/);
    await db.jessyReceivable.update({ where: { id: receivable.id }, data: { consultationId: consultation.id } });

    // Nothing above moved a single number.
    const after = await getJessySummary();
    ok("the ledger is byte-for-byte unchanged after every attempt",
       after.recorded === settled.recorded && after.settled === settled.settled &&
       after.outstanding === settled.outstanding,
       `${JSON.stringify(settled)} -> ${JSON.stringify(after)}`);
    ok("the identity still holds", money(after.recorded - after.settled) === after.outstanding,
       JSON.stringify(after));
    ok("the payment and its receivable both survived",
       (await db.payment.count({ where: { id: payment.id } })) === 1 &&
       (await db.jessyReceivable.count({ where: { id: receivable.id } })) === 1);
    ok("the allocation audit trail is intact", (await db.jessySettlementAllocation.count()) === 1);

    // A blocked write must reach the API as a clean 409 with the guard's own
    // sentence, not a 500 full of Prisma internals.
    let status = 0;
    let body: { error?: string } = {};
    try {
      await db.payment.delete({ where: { id: payment.id } });
    } catch (e) {
      const res = handleError(e);
      status = res.status;
      body = await res.json();
    }
    ok("a blocked write surfaces as 409, not 500", status === 409, `got ${status}`);
    ok("the response carries the readable guard message",
       (body.error ?? "").startsWith("Jessy has already settled money"), body.error ?? "(none)");
  }

  // ---- 12. Permissions: admin only, on BOTH the ledger and its settlements.
  // Driven through the real route handlers with real session cookies, so this
  // tests the deployed gate rather than a re-implementation of it.
  await reset();
  {
    const ledger = await import("@/app/api/jessy/route");
    const settlements = await import("@/app/api/jessy/settlements/route");

    // Leave a real outstanding balance so a permitted settlement genuinely works.
    const { basketId } = await makeVisit("Perms", 100);
    await settleVisitBasket(basketId, { splits: [{ method: "jessy", amount: 100 }], actorName: "Sec" });

    /** A signed-in request for `role`, carrying a genuine session cookie. */
    const asRole = async (role: string) => {
      const user = await db.user.create({
        data: { fullName: `${role} user`, email: `${role}@perm.local`, role, passwordHash: "x" },
      });
      const token = await createSession(user.id);
      return (url: string, init?: RequestInit) =>
        new Request(url, { ...init, headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } });
    };

    const admin = await asRole("admin");
    const secretary = await asRole("secretary");
    const dietitian = await asRole("dietitian");
    // Unauthenticated / invalid session: no cookie, and a forged one.
    const anon = (url: string, init?: RequestInit) => new Request(url, init);
    const forged = (url: string, init?: RequestInit) =>
      new Request(url, { ...init, headers: { cookie: `${SESSION_COOKIE_NAME}=not-a-real-token` } });

    const readLedger = (make: typeof anon) => ledger.GET(make("http://localhost/api/jessy"));
    const postSettlement = (make: typeof anon, amount: number) =>
      settlements.POST(
        make("http://localhost/api/jessy/settlements", {
          method: "POST",
          body: JSON.stringify({ amount }),
        }),
      );

    // Reads
    ok("admin can read the Jessy ledger", (await readLedger(admin)).status === 200,
       `got ${(await readLedger(admin)).status}`);
    ok("secretary is refused the Jessy ledger", (await readLedger(secretary)).status === 403);
    ok("dietitian is refused the Jessy ledger", (await readLedger(dietitian)).status === 403);
    ok("unauthenticated is refused the Jessy ledger", (await readLedger(anon)).status === 403);
    ok("an invalid session is refused the Jessy ledger", (await readLedger(forged)).status === 403);

    // Writes — the mismatch this task set out to fix.
    ok("secretary is refused settlement recording", (await postSettlement(secretary, 10)).status === 403);
    ok("dietitian is refused settlement recording", (await postSettlement(dietitian, 10)).status === 403);
    ok("unauthenticated is refused settlement recording", (await postSettlement(anon, 10)).status === 403);
    ok("an invalid session is refused settlement recording", (await postSettlement(forged, 10)).status === 403);
    ok("no refused request moved the balance", (await getJessySummary()).settled === 0,
       `settled=${(await getJessySummary()).settled}`);

    const allowed = await postSettlement(admin, 40);
    ok("admin can record a settlement", allowed.status === 201, `got ${allowed.status}`);
    const summary = await getJessySummary();
    ok("the admin's settlement applied correctly", summary.settled === 40 && summary.outstanding === 60,
       `settled=${summary.settled} outstanding=${summary.outstanding}`);

    // The read gate hides the figures, it doesn't just hide the page.
    const adminBody = await (await readLedger(admin)).json();
    ok("the admin ledger returns the real figures",
       adminBody.summary?.outstanding === 60 && adminBody.receivables?.length === 1,
       JSON.stringify(adminBody.summary));
    const secretaryBody = await (await readLedger(secretary)).json();
    ok("the refused response leaks no ledger data",
       secretaryBody.summary === undefined && secretaryBody.error === "Not allowed",
       JSON.stringify(secretaryBody));

    // Over-settlement is still refused for the one role that IS allowed.
    const tooMuch = await postSettlement(admin, 500);
    ok("admin over-settlement is still rejected (409)", tooMuch.status === 409, `got ${tooMuch.status}`);
    ok("the balance survived the rejected over-settlement",
       (await getJessySummary()).outstanding === 60);
  }

  await db.$disconnect();
}

main();
