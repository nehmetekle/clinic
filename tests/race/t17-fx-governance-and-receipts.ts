/**
 * Second-pass coverage: stale-rate checkout, suspicious-rate confirmation, the
 * FX rate audit history, printable receipts, and the removal of the historical
 * rate fallback. Test DB only (see run.sh).
 *
 * Everything here defends one sentence: the server alone decides what money is
 * worth, using the current authorised rate, and once a payment is recorded its
 * value can never move again.
 */
import { db } from "@/server/db";
import { createConsultation } from "@/server/repositories/consultations";
import { listVisitBaskets, settleVisitBasket } from "@/server/repositories/visitBaskets";
import { clearClientDebt, createClientDebtTx, listClientDebts } from "@/server/repositories/clientDebts";

import { listFxRateChanges, updateSettings, SuspiciousRateError } from "@/server/repositories/settings";
import { getReceiptData } from "@/server/repositories/receipts";
import { renderReceiptPdf } from "@/server/pdf/receipt-pdf";
import { updateSettingsSchema, settleVisitBasketSchema } from "@/lib/validation";
import { StaleFxRateError, detectSuspiciousRateChange, frozenPaymentFxRate, tenderToUsd } from "@/lib/money";

const ok = (label: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) process.exitCode = 1;
};

const USD_TO_EUR = 0.92;
const USD_TO_LBP = 89_500;
const ADMIN = { id: null as string | null, name: "Dr Admin" };

let phoneSeq = 0;
const nextPhone = () => `+9617013${String(5000 + phoneSeq++).padStart(4, "0")}`;

async function reset() {
  await db.$executeRawUnsafe(
    `TRUNCATE TABLE "JessySettlement", "JessyReceivable", "JessySettlementAllocation" CASCADE`,
  );
  await db.fxRateChange.deleteMany({});
  await db.auditLog.deleteMany({});
  await db.payment.deleteMany({});
  await db.consultation.deleteMany({});
  await db.client.deleteMany({});
  await db.user.deleteMany({});
  await db.servicePrice.deleteMany({});
  await db.setting.deleteMany({});
}

async function main() {
  await reset();

  const admin = await db.user.create({
    data: { fullName: "Rita Admin", email: "rita@test.local", role: "admin", passwordHash: "x" },
  });
  const doc = await db.user.create({
    data: { fullName: "Dr Gov", email: "gov@test.local", role: "dietitian", passwordHash: "x", consultationFee: 0 },
  });
  ADMIN.id = admin.id;
  ADMIN.name = admin.fullName;
  const actor = { actorId: admin.id, actorName: admin.fullName };

  const mkClient = (first: string) =>
    db.client.create({ data: { firstName: first, lastName: "Gov", phone: nextPhone() } });
  const billFor = async (clientId: string, usd: number) => {
    await db.user.update({ where: { id: doc.id }, data: { consultationFee: usd } });
    await createConsultation({ clientId, dietitianId: doc.id });
    const [b] = await listVisitBaskets({ clientId, status: "pending" });
    return b;
  };

  // Baseline rates. This is the first set, so no history is expected from it.
  await updateSettings({ usdToLbp: USD_TO_LBP, usdToEur: USD_TO_EUR, cardSurchargePercent: 0, ...actor });

  // ================================================== 1. FX rate audit history
  {
    let hist = await listFxRateChanges();
    ok("first-ever set is recorded, with no previous value", hist.length === 2 &&
       hist.every((h) => h.oldValue === undefined), JSON.stringify(hist.map((h) => [h.rateKey, h.oldValue])));

    await updateSettings({ usdToEur: 0.93, ...actor });
    hist = await listFxRateChanges();
    const eur = hist[0];
    ok("a normal EUR change saves without confirmation", eur.rateKey === "usdToEur" && eur.newValue === 0.93,
       JSON.stringify(eur));
    ok("…recording the old value", eur.oldValue === USD_TO_EUR, `old=${eur.oldValue}`);
    ok("…the actor, server-derived", eur.changedByName === "Rita Admin", eur.changedByName);
    ok("…a server timestamp", Number.isFinite(Date.parse(eur.changedAt)), eur.changedAt);
    ok("…and no suspicious marker", eur.suspiciousOverride === false);
    ok("the currency is resolved from the rate key", eur.currency === "EUR", eur.currency);

    await updateSettings({ usdToLbp: 90_000, ...actor });
    hist = await listFxRateChanges();
    ok("an LBP change is logged too",
       hist[0].rateKey === "usdToLbp" && hist[0].oldValue === USD_TO_LBP && hist[0].newValue === 90_000,
       JSON.stringify(hist[0]));

    // The Pricing form posts BOTH rates every save; an unchanged one must not
    // manufacture a history row that buries the real ones.
    const before = (await listFxRateChanges()).length;
    await updateSettings({ usdToLbp: 90_000, usdToEur: 0.93, ...actor });
    ok("re-saving unchanged rates writes no history", (await listFxRateChanges()).length === before,
       `${before} -> ${(await listFxRateChanges()).length}`);

    // The shared audit log gets a line too, where accountability events live.
    const auditRows = await db.auditLog.findMany({ where: { entityType: "FxRate" } });
    ok("every rate change also lands in the shared audit log", auditRows.length === 4,
       `${auditRows.length} rows`);
    ok("the audit line names the actor", auditRows.every((a) => a.userName === "Rita Admin"));

    await updateSettings({ usdToLbp: USD_TO_LBP, usdToEur: USD_TO_EUR, ...actor });
  }

  // =============================================== 2. Suspicious rate protection
  {
    // Pure detection first — the thresholds themselves.
    ok("0.92 -> 0.93 is not suspicious", detectSuspiciousRateChange("usdToEur", 0.92, 0.93) === null);
    ok("0.92 -> 92 IS suspicious", detectSuspiciousRateChange("usdToEur", 0.92, 92) !== null);
    ok("0.92 -> 0.0092 IS suspicious (÷100 too)", detectSuspiciousRateChange("usdToEur", 0.92, 0.0092) !== null);
    ok("89,500 -> 895 IS suspicious", detectSuspiciousRateChange("usdToLbp", 89_500, 895) !== null);
    ok("89,500 -> 120,000 is NOT (LBP re-pegs are real)",
       detectSuspiciousRateChange("usdToLbp", 89_500, 120_000) === null);
    ok("a first-ever set is never suspicious", detectSuspiciousRateChange("usdToEur", null, 92) === null);

    const historyBefore = (await listFxRateChanges()).length;
    let blocked: unknown = null;
    try {
      await updateSettings({ usdToEur: 92, ...actor });
    } catch (e) { blocked = e; }
    ok("a suspicious change is refused without confirmation", blocked instanceof SuspiciousRateError,
       String(blocked));
    ok("…naming the jump", (blocked as SuspiciousRateError).suspicions[0]?.rateKey === "usdToEur");
    ok("…and NOTHING is saved", (await db.setting.findUnique({ where: { key: "usdToEur" } }))?.value === "0.92",
       (await db.setting.findUnique({ where: { key: "usdToEur" } }))?.value);
    ok("…and no history row is written for a rejected change",
       (await listFxRateChanges()).length === historyBefore);

    // Absolute bounds fire BEFORE the suspicious check — a value outside
    // FX_BOUNDS is refused outright and cannot be confirmed at all.
    let outOfBounds = "";
    try {
      await updateSettings({ usdToEur: 920, confirmSuspicious: { usdToEur: 920 }, ...actor });
    } catch (e) { outOfBounds = (e as Error).message; }
    ok("an out-of-bounds rate cannot be confirmed through at all",
       outOfBounds.includes("outside the accepted range"), outOfBounds);

    // A confirmation for a DIFFERENT value must not wave this one through — this
    // is the attack the flag would otherwise be. 46 is inside the absolute bounds
    // but is still a 50x jump, so only the confirmation gate is being tested here.
    let stillBlocked: unknown = null;
    try {
      await updateSettings({ usdToEur: 46, confirmSuspicious: { usdToEur: 92 }, ...actor });
    } catch (e) { stillBlocked = e; }
    ok("a confirmation for another value does NOT authorise this one",
       stillBlocked instanceof SuspiciousRateError, String(stillBlocked));
    ok("…still nothing saved",
       (await db.setting.findUnique({ where: { key: "usdToEur" } }))?.value === "0.92");

    // The genuine confirm path.
    await updateSettings({ usdToEur: 92, confirmSuspicious: { usdToEur: 92 }, ...actor });
    const hist = await listFxRateChanges();
    ok("an explicitly confirmed suspicious change saves", hist[0].newValue === 92, JSON.stringify(hist[0]));
    ok("…and is flagged as an override in the history", hist[0].suspiciousOverride === true);
    const auditLine = await db.auditLog.findFirst({
      where: { entityType: "FxRate" }, orderBy: { createdAt: "desc" },
    });
    ok("…and the audit line says so in words",
       auditLine?.entityLabel.includes("SUSPICIOUS CHANGE CONFIRMED") === true, auditLine?.entityLabel);

    // Put it back (this is itself suspicious, so it needs its own confirmation).
    await updateSettings({ usdToEur: USD_TO_EUR, confirmSuspicious: { usdToEur: USD_TO_EUR }, ...actor });
    ok("restoring the rate also required confirmation and was logged",
       (await listFxRateChanges())[0].suspiciousOverride === true);

    // Schema-level abuse of the confirmation object.
    ok("a non-numeric confirmation is rejected by the schema",
       !updateSettingsSchema.safeParse({ usdToEur: 92, confirmSuspicious: { usdToEur: "yes" } }).success);
    ok("a negative confirmation is rejected",
       !updateSettingsSchema.safeParse({ usdToEur: 92, confirmSuspicious: { usdToEur: -1 } }).success);
    ok("an unknown key in the confirmation is stripped, not honoured",
       !("nope" in ((updateSettingsSchema.safeParse({ usdToEur: 0.93, confirmSuspicious: { nope: 1 } })
         .data?.confirmSuspicious ?? {}) as Record<string, unknown>)));
  }

  // ==================================================== 3. Stale-rate checkout
  {
    const c = await mkClient("Stale");
    const b = await billFor(c.id, 400);

    // Desk prepares €368 = $400 at 0.92. Admin then moves the rate to 0.90.
    await updateSettings({ usdToEur: 0.9, ...actor });

    let stale: unknown = null;
    try {
      await settleVisitBasket(b.id, {
        splits: [{ method: "cash", currency: "EUR", amount: 368 }],
        expectedRates: { EUR: USD_TO_EUR },
        actorName: "Sec",
      });
    } catch (e) { stale = e; }
    ok("a settlement prepared at a stale rate is refused", stale instanceof StaleFxRateError, String(stale));
    ok("…with a message naming the real cause, not an arithmetic error",
       (stale as Error).message.includes("exchange rate changed"), (stale as Error).message);
    ok("…carrying the authoritative rates so the screen can re-price",
       (stale as StaleFxRateError).rates.usdToEur === 0.9);
    ok("…and the detail of what moved",
       (stale as StaleFxRateError).detail[0]?.displayedRate === USD_TO_EUR &&
       (stale as StaleFxRateError).detail[0]?.currentRate === 0.9,
       JSON.stringify((stale as StaleFxRateError).detail));
    ok("NO payment rows were written", (await db.payment.count({ where: { visitBasketId: b.id } })) === 0);
    ok("the basket is still pending",
       (await db.visitBasket.findUniqueOrThrow({ where: { id: b.id } })).status === "pending");

    // Re-priced at the CURRENT rate, the same settlement succeeds.
    await settleVisitBasket(b.id, {
      splits: [{ method: "cash", currency: "EUR", amount: 360 }], // 360 / 0.90 = $400
      expectedRates: { EUR: 0.9 },
      actorName: "Sec",
    });
    const paid = await db.payment.findFirstOrThrow({ where: { visitBasketId: b.id } });
    ok("resubmitting at the current rate settles", paid.amountPaid === 360 && paid.fxRate === 0.9,
       `${paid.amountPaid} @ ${paid.fxRate}`);

    // A rate that moved for a currency this settlement does NOT use must not block it.
    const c2 = await mkClient("Unrelated");
    const b2 = await billFor(c2.id, 50);
    await settleVisitBasket(b2.id, {
      splits: [{ method: "cash", currency: "USD", amount: 50 }],
      expectedRates: { EUR: 0.5, LBP: 1 }, // both wildly stale, neither is used
      actorName: "Sec",
    });
    ok("a stale rate for an UNUSED currency does not block a USD settlement",
       (await db.visitBasket.findUniqueOrThrow({ where: { id: b2.id } })).status === "paid");

    // Omitting expectedRates entirely keeps the original behaviour (no staleness
    // signal available), and the ordinary reconcile check still guards the total.
    const c3 = await mkClient("NoExpect");
    const b3 = await billFor(c3.id, 100);
    await settleVisitBasket(b3.id, {
      splits: [{ method: "cash", currency: "USD", amount: 100 }],
      actorName: "Sec",
    });
    ok("a settlement with no expectedRates still works",
       (await db.visitBasket.findUniqueOrThrow({ where: { id: b3.id } })).status === "paid");

    // A FORGED expectedRates cannot change any figure — worst case it refuses
    // its own settlement. It can never make a leg worth more than its rate says.
    const c4 = await mkClient("Forged");
    const b4 = await billFor(c4.id, 100);
    let forged = "";
    try {
      await settleVisitBasket(b4.id, {
        // Claims the screen showed 0.001 EUR/USD (i.e. €1 = $1000).
        splits: [{ method: "cash", currency: "EUR", amount: 1 }],
        expectedRates: { EUR: 0.001 },
        actorName: "Sec",
      });
    } catch (e) { forged = (e as Error).message; }
    ok("a forged expectedRates only refuses its own settlement, never revalues",
       forged.includes("exchange rate changed"), forged);
    ok("…and records nothing", (await db.payment.count({ where: { visitBasketId: b4.id } })) === 0);

    ok("the schema rejects a non-positive expectedRate",
       !settleVisitBasketSchema.safeParse({ splits: [], expectedRates: { EUR: 0 } }).success);

    await updateSettings({ usdToEur: USD_TO_EUR, ...actor });
  }

  // ====================================== 4. No historical fallback (item 11)
  {
    // The DB constraint makes an unvaluable payment impossible to insert.
    let blocked = false;
    try {
      await db.payment.create({
        data: {
          motif: "legacy", amountPaid: 100, currency: "LBP", usdToLbp: 0, fxRate: null,
          method: "cash", receiptNumber: "RCP-LEGACY-1",
        },
      });
    } catch { blocked = true; }
    ok("the DB refuses an LBP payment with no usable rate at all", blocked);

    // A legacy-SHAPED row (fxRate null, usdToLbp set) is still valued from its own
    // snapshot — that is history, not a guess.
    const legacy = await db.payment.create({
      data: {
        motif: "legacy", amountPaid: 8_950_000, currency: "LBP", usdToLbp: 89_500, fxRate: null,
        method: "cash", receiptNumber: "RCP-LEGACY-2",
      },
    });
    const resolved = frozenPaymentFxRate(legacy);
    ok("a pre-fxRate LBP row is valued from its OWN usdToLbp snapshot",
       resolved.fxRate === 89_500 && tenderToUsd(legacy.amountPaid, "LBP", resolved.fxRate) === 100,
       JSON.stringify(resolved));

    // …and it does NOT move when today's rate changes.
    await updateSettings({ usdToLbp: 150_000, confirmSuspicious: { usdToLbp: 150_000 }, ...actor });
    const after = frozenPaymentFxRate(await db.payment.findUniqueOrThrow({ where: { id: legacy.id } }));
    ok("a rate change does not re-value a legacy row", after.fxRate === 89_500, `${after.fxRate}`);
    await updateSettings({ usdToLbp: USD_TO_LBP, confirmSuspicious: { usdToLbp: USD_TO_LBP }, ...actor });

    // An in-memory malformed row throws rather than inventing a rate.
    let threw = "";
    try {
      frozenPaymentFxRate({ currency: "EUR", usdToLbp: 89_500, fxRate: null, receiptNumber: "RCP-X" });
    } catch (e) { threw = (e as Error).message; }
    ok("a EUR row with no frozen rate THROWS instead of using a default",
       threw.includes("no valid frozen exchange rate"), threw);
    ok("…and the error names the row so it can be found", threw.includes("RCP-X"), threw);

    threw = "";
    try {
      frozenPaymentFxRate({ currency: "LBP", usdToLbp: 0, fxRate: 0 });
    } catch (e) { threw = (e as Error).message; }
    ok("an LBP row with a zero snapshot AND zero fxRate throws", threw.length > 0, threw);

    await db.payment.delete({ where: { id: legacy.id } });
  }

  // ================================================================ 5. Receipts
  {
    // --- USD-only receipt stays clean.
    const c = await mkClient("UsdReceipt");
    const b = await billFor(c.id, 250);
    await settleVisitBasket(b.id, {
      splits: [{ method: "cash", currency: "USD", amount: 250 }],
      actorName: "Sec",
    });
    const p1 = await db.payment.findFirstOrThrow({ where: { visitBasketId: b.id } });
    const r1 = await getReceiptData(p1.id);
    ok("USD receipt: one tender line, no FX flag",
       r1.tender.length === 1 && r1.hasForeignTender === false, JSON.stringify(r1.tender));
    ok("USD receipt: due, paid and balance reconcile",
       r1.dueUsd === 250 && r1.paidUsd === 250 && r1.balanceUsd === 0,
       `${r1.dueUsd}/${r1.paidUsd}/${r1.balanceUsd}`);
    ok("USD receipt: names the patient and the visit", r1.clientName === "UsdReceipt Gov");
    const pdf1 = await renderReceiptPdf(r1);
    ok("USD receipt renders to a PDF", pdf1.length > 1000 && pdf1.subarray(0, 4).toString() === "%PDF",
       `${pdf1.length} bytes`);

    // --- The mixed-currency worked example.
    const c2 = await mkClient("MixReceipt");
    const b2 = await billFor(c2.id, 1000);
    const eurUsd = tenderToUsd(200, "EUR", USD_TO_EUR);
    const lbpUsd = tenderToUsd(20_000_000, "LBP", USD_TO_LBP);
    const rest = Math.round((1000 - 100 - eurUsd - lbpUsd) * 100) / 100;
    await settleVisitBasket(b2.id, {
      splits: [
        { method: "cash", currency: "USD", amount: 100 },
        { method: "cash", currency: "EUR", amount: 200 },
        { method: "card", currency: "LBP", amount: 20_000_000 },
        { method: "whish", currency: "USD", amount: rest },
      ],
      actorName: "Sec",
    });
    const legs = await db.payment.findMany({ where: { visitBasketId: b2.id }, orderBy: { receiptNumber: "asc" } });
    const r2 = await getReceiptData(legs[0].id);
    ok("mixed receipt lists all four legs", r2.tender.length === 4, `${r2.tender.length}`);
    ok("mixed receipt is flagged as foreign", r2.hasForeignTender === true);
    ok("mixed receipt: bill total is the USD obligation", r2.dueUsd === 1000, `${r2.dueUsd}`);
    ok("mixed receipt: USD-equivalent paid reconciles", r2.paidUsd === 1000, `${r2.paidUsd}`);
    ok("mixed receipt: balance is zero", r2.balanceUsd === 0, `${r2.balanceUsd}`);
    const eurLine = r2.tender.find((t) => t.currency === "EUR")!;
    ok("mixed receipt: EUR line keeps its NATIVE amount", eurLine.nativeAmount === 200);
    ok("mixed receipt: EUR line carries the FROZEN rate", eurLine.fxRate === USD_TO_EUR);
    ok("mixed receipt: EUR line shows the equivalent", eurLine.usdEquivalent === 217.39, `${eurLine.usdEquivalent}`);
    const lbpLine = r2.tender.find((t) => t.currency === "LBP")!;
    ok("mixed receipt: LBP line native + rate + equivalent",
       lbpLine.nativeAmount === 20_000_000 && lbpLine.fxRate === USD_TO_LBP && lbpLine.usdEquivalent === 223.46,
       JSON.stringify(lbpLine));
    ok("mixed receipt: every leg carries its own receipt number",
       new Set(r2.tender.map((t) => t.receiptNumber)).size === 4);
    ok("mixed receipt: the basket's items are itemised", r2.items.length > 0);
    const pdf2 = await renderReceiptPdf(r2);
    ok("mixed receipt renders to a PDF", pdf2.length > 1000 && pdf2.subarray(0, 4).toString() === "%PDF");

    // Printing from ANY leg produces the same complete receipt.
    const fromOtherLeg = await getReceiptData(legs[2].id);
    ok("printing from any leg yields the whole settlement",
       fromOtherLeg.tender.length === 4 && fromOtherLeg.paidUsd === 1000);

    // --- HISTORICAL STABILITY: the whole point.
    await updateSettings({ usdToEur: 0.5, confirmSuspicious: { usdToEur: 0.5 }, ...actor });
    await updateSettings({ usdToLbp: 200_000, confirmSuspicious: { usdToLbp: 200_000 }, ...actor });
    const r2After = await getReceiptData(legs[0].id);
    ok("a reprint after BOTH rates changed is byte-identical in every figure",
       JSON.stringify(r2After) === JSON.stringify(r2),
       `paid ${r2.paidUsd} -> ${r2After.paidUsd}`);
    await updateSettings({ usdToEur: USD_TO_EUR, confirmSuspicious: { usdToEur: USD_TO_EUR }, ...actor });
    await updateSettings({ usdToLbp: USD_TO_LBP, confirmSuspicious: { usdToLbp: USD_TO_LBP }, ...actor });

    // --- Card surcharge is shown separately, not folded into the charge.
    await updateSettings({ cardSurchargePercent: 10, ...actor });
    const c3 = await mkClient("FeeReceipt");
    const b3 = await billFor(c3.id, 100);
    await settleVisitBasket(b3.id, {
      splits: [{ method: "card", currency: "EUR", amount: 92 }],
      actorName: "Sec",
    });
    const p3 = await db.payment.findFirstOrThrow({ where: { visitBasketId: b3.id } });
    const r3 = await getReceiptData(p3.id);
    ok("receipt separates the card fee from the charge",
       r3.tender[0].nativeAmount === 92 && r3.tender[0].cardSurchargeAmount === 9.2,
       JSON.stringify(r3.tender[0]));
    ok("…and the charge still reconciles to the bill", r3.paidUsd === 100 && r3.balanceUsd === 0,
       `${r3.paidUsd}`);
    ok("…with the fee reported in USD too", r3.totalCardSurchargeUsd === 10, `${r3.totalCardSurchargeUsd}`);
    await updateSettings({ cardSurchargePercent: 0, ...actor });

    // --- A debt collection receipt.
    const c4 = await mkClient("DebtReceipt");
    const debtId = await db.$transaction((tx) =>
      createClientDebtTx(tx, { clientId: c4.id, amount: 400, reason: "Owed", source: "secretary_override" }),
    );
    await clearClientDebt(debtId!, {
      method: "cash", tender: [{ method: "cash", currency: "EUR", amount: 200 }],
    });
    const dp = await db.payment.findFirstOrThrow({ where: { clientId: c4.id } });
    const r4 = await getReceiptData(dp.id);
    ok("a debt-collection receipt exists and labels itself",
       r4.dueLabel === "Collected against debt", r4.dueLabel);
    ok("…showing the native EUR and its equivalent",
       r4.tender[0].currency === "EUR" && r4.tender[0].nativeAmount === 200 &&
       r4.tender[0].usdEquivalent === 217.39, JSON.stringify(r4.tender[0]));
    const pdf4 = await renderReceiptPdf(r4);
    ok("debt receipt renders", pdf4.subarray(0, 4).toString() === "%PDF");

    // Partial then complete, per the brief's worked example.
    let debt = (await listClientDebts(c4.id))[0];
    ok("debt: €200 leaves $182.61 outstanding", debt.outstandingAmount === 182.61, `${debt.outstandingAmount}`);
    await clearClientDebt(debtId!, {
      method: "cash",
      tender: [{ method: "cash", currency: "LBP", amount: Math.round(182.61 * USD_TO_LBP) }],
    });
    debt = (await listClientDebts(c4.id))[0];
    ok("debt: completing in LBP clears it exactly",
       debt.status === "cleared" && debt.outstandingAmount === 0 && debt.amount === 400,
       JSON.stringify({ s: debt.status, o: debt.outstandingAmount, a: debt.amount }));

    // A receipt for a payment that does not exist is a 404, not a blank document.
    let missing = "";
    try { await getReceiptData("does-not-exist"); } catch (e) { missing = (e as Error).message; }
    ok("an unknown payment id yields Not found, never an empty receipt",
       missing.includes("not found") || missing.includes("Receipt not found"), missing);
  }

  // ============================================ 6. Concurrency on the new paths
  {
    // Two admins confirming the same suspicious change at once must both end at
    // the same value, with one history row each and no lost/duplicated update.
    await updateSettings({ usdToEur: USD_TO_EUR, ...actor });
    const before = (await listFxRateChanges()).length;
    const both = await Promise.allSettled([
      updateSettings({ usdToEur: 9.2, confirmSuspicious: { usdToEur: 9.2 }, ...actor }),
      updateSettings({ usdToEur: 9.2, confirmSuspicious: { usdToEur: 9.2 }, ...actor }),
    ]);
    const settled = await db.setting.findUniqueOrThrow({ where: { key: "usdToEur" } });
    ok("concurrent identical confirms converge on one value", settled.value === "9.2", settled.value);
    const added = (await listFxRateChanges()).length - before;
    // Serialized by the advisory lock in updateSettings: whichever transaction
    // goes second sees the NEW value as `current` and writes nothing, so exactly
    // one row is added. Without that lock both read the stale "before" and both
    // logged it — a history that plausibly lies about what the value was.
    ok("…and record exactly one history row between them", added === 1, `${added} rows added`);
    ok("…with neither request erroring unexpectedly",
       both.every((r) => r.status === "fulfilled"), JSON.stringify(both.map((r) => r.status)));
    await updateSettings({ usdToEur: USD_TO_EUR, confirmSuspicious: { usdToEur: USD_TO_EUR }, ...actor });

    // Two admins setting DIFFERENT values at once. The history must describe a
    // real sequence: each row's oldValue must be the previous row's newValue (or
    // the starting value), never two rows both claiming the same "before".
    const start = (await listFxRateChanges()).length;
    await Promise.allSettled([
      updateSettings({ usdToEur: 1.0, ...actor }),
      updateSettings({ usdToEur: 1.1, ...actor }),
    ]);
    const chain = (await listFxRateChanges()).slice(0, (await listFxRateChanges()).length - start).reverse();
    const finalValue = Number((await db.setting.findUniqueOrThrow({ where: { key: "usdToEur" } })).value);
    let prev = USD_TO_EUR;
    let chained = true;
    for (const row of chain) {
      if (row.oldValue !== prev) chained = false;
      prev = row.newValue;
    }
    ok("concurrent DIFFERING rate changes record a truthful chain",
       chained && chain.length > 0, JSON.stringify(chain.map((r) => [r.oldValue, r.newValue])));
    ok("…ending at the value actually stored", prev === finalValue, `${prev} vs ${finalValue}`);
    await updateSettings({ usdToEur: USD_TO_EUR, ...actor });
  }

  await db.$disconnect();
}

main();
