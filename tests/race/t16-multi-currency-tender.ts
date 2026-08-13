/**
 * Multi-currency TENDER against USD obligations. Test DB only (see run.sh).
 *
 * The invariant under test, end to end:
 *
 *   Bills, baskets and debts are denominated in USD.
 *   Payments may be tendered in USD, EUR or LBP.
 *   Every leg is valued at the rate FROZEN on its own payment, so changing the
 *   admin rate afterwards can never re-price history.
 *
 * Locks in: the USD-only settlement path behaving EXACTLY as before (no
 * regression), EUR/LBP legs converting correctly, method × currency staying
 * economically distinct, under/over-payment refusal at the documented tolerance,
 * client-supplied FX being ignored, Jessy staying USD-only, card surcharge not
 * double-rounding or double-applying, partial debt collection in foreign tender,
 * and concurrent settlement of one basket producing exactly one payment set.
 */
import { db } from "@/server/db";
import { createConsultation } from "@/server/repositories/consultations";
import { listVisitBaskets, settleVisitBasket } from "@/server/repositories/visitBaskets";
import { clearClientDebt, createClientDebtTx, listClientDebts } from "@/server/repositories/clientDebts";
import { createPayment } from "@/server/repositories/payments";
import { updateSettings } from "@/server/repositories/settings";
import { settleVisitBasketSchema, updateSettingsSchema, createPaymentSchema } from "@/lib/validation";
import { tenderToUsd, settlementToleranceUsd } from "@/lib/money";

const ok = (label: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) process.exitCode = 1;
};

const USD_TO_EUR = 0.92;
const USD_TO_LBP = 89_500;

let phoneSeq = 0;
const nextPhone = () => `+9617012${String(4000 + phoneSeq++).padStart(4, "0")}`;

async function reset() {
  await db.$executeRawUnsafe(
    `TRUNCATE TABLE "JessySettlement", "JessyReceivable", "JessySettlementAllocation" CASCADE`,
  );
  await db.auditLog.deleteMany({});
  await db.payment.deleteMany({});
  await db.consultation.deleteMany({});
  await db.client.deleteMany({});
  await db.user.deleteMany({});
  await db.servicePrice.deleteMany({});
  await db.setting.deleteMany({});
}

/** A tracked USD debt, via the same path settlement uses. */
async function makeDebt(clientId: string, amount: number, reason: string) {
  const id = await db.$transaction((tx) =>
    createClientDebtTx(tx, { clientId, amount, reason, source: "secretary_override" }),
  );
  return (await listClientDebts(clientId)).find((d) => d.id === id)!;
}

/** A saved visit whose basket totals exactly `usd`, via one custom-priced line. */
async function billFor(clientId: string, dietitianId: string, usd: number) {
  await db.user.update({ where: { id: dietitianId }, data: { consultationFee: usd } });
  await createConsultation({ clientId, dietitianId });
  const [basket] = await listVisitBaskets({ clientId, status: "pending" });
  return basket;
}

async function main() {
  await reset();
  await updateSettings({ usdToLbp: USD_TO_LBP, usdToEur: USD_TO_EUR, cardSurchargePercent: 0 });

  const doc = await db.user.create({
    data: { fullName: "Dr FX", email: "fx@test.local", role: "dietitian", passwordHash: "x", consultationFee: 0 },
  });
  const mkClient = (first: string) =>
    db.client.create({ data: { firstName: first, lastName: "Tender", phone: nextPhone() } });

  // ---------------------------------------------------------------- 1. USD regression
  {
    const c = await mkClient("UsdOnly");
    const b = await billFor(c.id, doc.id, 1000);
    ok("bill is $1000", b.total === 1000, `got ${b.total}`);
    await settleVisitBasket(b.id, { splits: [{ method: "cash", amount: 1000 }], actorName: "Sec" });
    const pays = await db.payment.findMany({ where: { visitBasketId: b.id } });
    ok("USD-only settlement is unchanged: one payment, $1000, no fxRate drama",
       pays.length === 1 && pays[0].amountPaid === 1000 && pays[0].currency === "USD" && pays[0].fxRate === 1,
       JSON.stringify(pays.map((p) => [p.amountPaid, p.currency, p.fxRate])));
  }

  // ------------------------------------------ 2. The worked example from the brief
  // $1000 = $100 cash USD + €200 cash EUR + 20,000,000 LBP card + the rest cash USD
  {
    const c = await mkClient("Mixed");
    const b = await billFor(c.id, doc.id, 1000);
    const eurUsd = tenderToUsd(200, "EUR", USD_TO_EUR);      // 217.39
    const lbpUsd = tenderToUsd(20_000_000, "LBP", USD_TO_LBP); // 223.46
    const restUsd = Math.round((1000 - 100 - eurUsd - lbpUsd) * 100) / 100; // 459.15
    ok("€200 = $217.39", eurUsd === 217.39, `got ${eurUsd}`);
    ok("20,000,000 LBP = $223.46", lbpUsd === 223.46, `got ${lbpUsd}`);

    await settleVisitBasket(b.id, {
      splits: [
        { method: "cash", currency: "USD", amount: 100 },
        { method: "cash", currency: "EUR", amount: 200 },
        { method: "card", currency: "LBP", amount: 20_000_000 },
        { method: "whish", currency: "USD", amount: restUsd },
      ],
      actorName: "Sec",
    });
    const pays = await db.payment.findMany({ where: { visitBasketId: b.id }, orderBy: { receiptNumber: "asc" } });
    ok("four distinct payment rows", pays.length === 4, `got ${pays.length}`);
    ok("native amounts survive un-normalised",
       pays.some((p) => p.currency === "EUR" && p.amountPaid === 200) &&
       pays.some((p) => p.currency === "LBP" && p.amountPaid === 20_000_000),
       JSON.stringify(pays.map((p) => [p.currency, p.amountPaid])));
    ok("each leg froze its own rate",
       pays.every((p) =>
         p.currency === "USD" ? p.fxRate === 1
         : p.currency === "EUR" ? p.fxRate === USD_TO_EUR
         : p.fxRate === USD_TO_LBP),
       JSON.stringify(pays.map((p) => [p.currency, p.fxRate])));
    const totalUsd = pays.reduce((s, p) => s + tenderToUsd(p.amountPaid, p.currency as never, p.fxRate!), 0);
    ok("USD equivalents sum to the $1000 bill",
       Math.abs(totalUsd - 1000) <= settlementToleranceUsd(pays.map((p) => ({ currency: p.currency as never }))),
       `got ${totalUsd}`);
    const basket = (await listVisitBaskets({ clientId: c.id }))[0];
    ok("basket total is still exactly $1000 (the bill never became foreign)",
       basket.total === 1000, `got ${basket.total}`);
  }

  // -------------------------------------------------- 3. Frozen rate vs a rate change
  {
    const c = await mkClient("Frozen");
    const b = await billFor(c.id, doc.id, 400);
    await settleVisitBasket(b.id, {
      splits: [{ method: "cash", currency: "EUR", amount: 368 }],
      actorName: "Sec",
    });
    const before = await db.payment.findFirstOrThrow({ where: { visitBasketId: b.id } });
    ok("€368 settles a $400 bill", tenderToUsd(before.amountPaid, "EUR", before.fxRate!) === 400,
       `got ${tenderToUsd(before.amountPaid, "EUR", before.fxRate!)}`);

    await updateSettings({ usdToEur: 0.88 });
    const after = await db.payment.findFirstOrThrow({ where: { id: before.id } });
    ok("the rate change did NOT touch the stored payment",
       after.fxRate === USD_TO_EUR && after.amountPaid === 368, `fxRate=${after.fxRate}`);
    ok("its USD value is unchanged at the frozen rate",
       tenderToUsd(after.amountPaid, "EUR", after.fxRate!) === 400,
       `got ${tenderToUsd(after.amountPaid, "EUR", after.fxRate!)}`);
    // A NEW payment must use the NEW rate.
    const fresh = await createPayment({
      clientId: c.id, motif: "post-change", amountPaid: 88, currency: "EUR", method: "cash",
    });
    ok("a new payment uses the new rate", fresh.fxRate === 0.88, `got ${fresh.fxRate}`);
    ok("…and is valued at $100", fresh.amountUsd === 100, `got ${fresh.amountUsd}`);
    await updateSettings({ usdToEur: USD_TO_EUR });
  }

  // ------------------------------------- 4. Same method, different currencies stay apart
  {
    const c = await mkClient("SameMethod");
    const b = await billFor(c.id, doc.id, 500);
    // 100 USD + 92 EUR (=$100) + 26,850,000 LBP (=$300), all "cash".
    await settleVisitBasket(b.id, {
      splits: [
        { method: "cash", currency: "USD", amount: 100 },
        { method: "cash", currency: "EUR", amount: 92 },
        { method: "cash", currency: "LBP", amount: 26_850_000 },
      ],
      actorName: "Sec",
    });
    const pays = await db.payment.findMany({ where: { visitBasketId: b.id } });
    ok("three cash legs are NOT folded into one",
       pays.length === 3 && new Set(pays.map((p) => p.currency)).size === 3,
       JSON.stringify(pays.map((p) => [p.method, p.currency, p.amountPaid])));
    ok("each carries its own receipt", new Set(pays.map((p) => p.receiptNumber)).size === 3);
  }

  // ------------------------------------------- 5. Duplicate (method, currency) DOES fold
  {
    const c = await mkClient("Folded");
    const b = await billFor(c.id, doc.id, 300);
    await settleVisitBasket(b.id, {
      splits: [
        { method: "cash", currency: "USD", amount: 100 },
        { method: "cash", currency: "USD", amount: 200 },
      ],
      actorName: "Sec",
    });
    const pays = await db.payment.findMany({ where: { visitBasketId: b.id } });
    ok("two identical-leg entries fold into one $300 payment",
       pays.length === 1 && pays[0].amountPaid === 300,
       JSON.stringify(pays.map((p) => p.amountPaid)));
  }

  // --------------------------------------------------- 6. Under- and over-payment
  {
    const c = await mkClient("Short");
    const b = await billFor(c.id, doc.id, 1000);
    let under = "";
    try {
      await settleVisitBasket(b.id, {
        splits: [{ method: "cash", currency: "EUR", amount: 360 }], // $391.30
        actorName: "Sec",
      });
    } catch (e) { under = (e as Error).message; }
    ok("materially short settlement is refused", under.includes("short"), under || "no error");

    let over = "";
    try {
      await settleVisitBasket(b.id, {
        splits: [
          { method: "cash", currency: "USD", amount: 1000 },
          { method: "cash", currency: "EUR", amount: 10 },
        ],
        actorName: "Sec",
      });
    } catch (e) { over = (e as Error).message; }
    ok("over-payment is refused too", over.includes("too much"), over || "no error");
    ok("the basket survived both refusals unsettled",
       (await db.visitBasket.findUniqueOrThrow({ where: { id: b.id } })).status === "pending");
    ok("no payment rows leaked from the refused attempts",
       (await db.payment.count({ where: { visitBasketId: b.id } })) === 0);
  }

  // ------------------------------------------------- 7. Precision boundary (tolerance)
  {
    // One converted leg buys 0.005 of allowance on top of the base 0.005 => 0.01.
    const c = await mkClient("Boundary");
    const b = await billFor(c.id, doc.id, 100);
    let inside = "ok";
    try {
      // 91.99 EUR = 99.9891… -> rounds to 99.99, i.e. 1c short. Outside 0.01.
      await settleVisitBasket(b.id, {
        splits: [{ method: "cash", currency: "EUR", amount: 91.99 }],
        actorName: "Sec",
      });
    } catch (e) { inside = (e as Error).message; }
    ok("a full cent short is REFUSED (tolerance is not a discount)",
       inside.includes("short"), inside);

    // 92 EUR = exactly 100.00 -> accepted.
    await settleVisitBasket(b.id, {
      splits: [{ method: "cash", currency: "EUR", amount: 92 }],
      actorName: "Sec",
    });
    ok("the exact foreign equivalent settles",
       (await db.visitBasket.findUniqueOrThrow({ where: { id: b.id } })).status === "paid");
  }

  // --------------------------------------------------------- 8. Schema-level rejection
  {
    const bad = (body: unknown) => settleVisitBasketSchema.safeParse(body);
    ok("unsupported currency is rejected by the schema",
       !bad({ splits: [{ method: "cash", currency: "GBP", amount: 10 }] }).success);
    ok("negative leg amount is rejected",
       !bad({ splits: [{ method: "cash", currency: "USD", amount: -5 }] }).success);
    ok("Infinity leg amount is rejected",
       !bad({ splits: [{ method: "cash", currency: "USD", amount: 1e400 }] }).success);
    ok("NaN leg amount is rejected",
       !bad({ splits: [{ method: "cash", currency: "USD", amount: Number.NaN }] }).success);
    ok("absurdly large USD leg is rejected",
       !bad({ splits: [{ method: "cash", currency: "USD", amount: 9_999_999 }] }).success);
    ok("a large LBP leg is ACCEPTED (capped in its own currency)",
       bad({ splits: [{ method: "cash", currency: "LBP", amount: 20_000_000 }] }).success);
    ok("omitting currency still parses, defaulting to USD",
       bad({ splits: [{ method: "cash", amount: 10 }] }).data?.splits[0].currency === "USD");

    // A fabricated FX rate / USD-equivalent from the client has nowhere to land:
    // the schema strips unknown keys, so the server can only use its own rate.
    const crafted = bad({
      splits: [{ method: "cash", currency: "EUR", amount: 1, fxRate: 0.001, amountUsd: 1000 }],
    });
    const leg = crafted.data?.splits[0] as Record<string, unknown> | undefined;
    ok("a client-supplied fxRate/amountUsd is stripped, never trusted",
       crafted.success && leg !== undefined && !("fxRate" in leg) && !("amountUsd" in leg),
       JSON.stringify(leg));

    ok("an infinite admin rate is rejected",
       !updateSettingsSchema.safeParse({ usdToLbp: Number.POSITIVE_INFINITY }).success);
    ok("an absurd admin rate is rejected",
       !updateSettingsSchema.safeParse({ usdToEur: 1e9 }).success);
    ok("a zero admin rate is rejected", !updateSettingsSchema.safeParse({ usdToLbp: 0 }).success);
  }

  // ----------------------------------------------------------------- 9. Client FX manipulation
  {
    const c = await mkClient("Crafted");
    const b = await billFor(c.id, doc.id, 1000);
    // €1 claimed as the whole bill: the server converts at ITS rate ($1.09) and refuses.
    let refused = "";
    try {
      await settleVisitBasket(b.id, {
        splits: [{ method: "cash", currency: "EUR", amount: 1 }],
        actorName: "Sec",
      });
    } catch (e) { refused = (e as Error).message; }
    ok("€1 cannot settle a $1000 bill", refused.includes("short"), refused || "no error");
    ok("the crafted request recorded nothing",
       (await db.payment.count({ where: { visitBasketId: b.id } })) === 0);
  }

  // --------------------------------------------------------------------- 10. Jessy
  {
    const c = await mkClient("JessyPay");
    const b = await billFor(c.id, doc.id, 200);
    for (const currency of ["EUR", "LBP"] as const) {
      let msg = "";
      try {
        await settleVisitBasket(b.id, {
          splits: [{ method: "jessy", currency, amount: currency === "EUR" ? 184 : 17_900_000 }],
          actorName: "Sec",
        });
      } catch (e) { msg = (e as Error).message; }
      ok(`Jessy/${currency} is refused server-side`, msg.includes("USD-only"), msg || "no error");
    }
    ok("the schema refuses Jessy/EUR too (defence in depth)",
       !settleVisitBasketSchema.safeParse({ splits: [{ method: "jessy", currency: "EUR", amount: 1 }] }).success);
    ok("createPayment refuses Jessy/EUR at the chokepoint",
       !createPaymentSchema.safeParse({ motif: "x", amountPaid: 1, currency: "EUR", method: "jessy" }).success);
    // Jessy/USD still works exactly as before.
    await settleVisitBasket(b.id, {
      splits: [{ method: "jessy", currency: "USD", amount: 200 }],
      actorName: "Sec",
    });
    const rec = await db.jessyReceivable.findMany();
    ok("Jessy/USD still raises a $200 receivable",
       rec.length === 1 && rec[0].amount === 200 && rec[0].remaining === 200,
       JSON.stringify(rec.map((r) => [r.amount, r.remaining])));
  }

  // ------------------------------------------------------------- 11. Card surcharge
  {
    await updateSettings({ cardSurchargePercent: 10 });
    const c = await mkClient("CardFx");
    const b = await billFor(c.id, doc.id, 300);
    // 92 EUR (=$100) card + 8,950,000 LBP (=$100) card + $100 card.
    await settleVisitBasket(b.id, {
      splits: [
        { method: "card", currency: "EUR", amount: 92 },
        { method: "card", currency: "LBP", amount: 8_950_000 },
        { method: "card", currency: "USD", amount: 100 },
      ],
      actorName: "Sec",
    });
    const pays = await db.payment.findMany({ where: { visitBasketId: b.id } });
    const eur = pays.find((p) => p.currency === "EUR")!;
    const lbp = pays.find((p) => p.currency === "LBP")!;
    const usd = pays.find((p) => p.currency === "USD")!;
    ok("EUR card fee is 10% of the NATIVE amount, applied once",
       eur.cardSurchargeAmount === 9.2 && eur.amountPaid === 101.2,
       `fee=${eur.cardSurchargeAmount} total=${eur.amountPaid}`);
    ok("LBP card fee likewise", lbp.cardSurchargeAmount === 895_000 && lbp.amountPaid === 9_845_000,
       `fee=${lbp.cardSurchargeAmount} total=${lbp.amountPaid}`);
    ok("USD card fee is unchanged from before", usd.cardSurchargeAmount === 10 && usd.amountPaid === 110,
       `fee=${usd.cardSurchargeAmount} total=${usd.amountPaid}`);
    // The fee is on TOP: the basket-attributable portion still sums to the bill.
    const net = pays.reduce(
      (s, p) => s + tenderToUsd(p.amountPaid - p.cardSurchargeAmount, p.currency as never, p.fxRate!), 0);
    ok("net-of-fee USD equivalents still sum to the $300 bill", Math.abs(net - 300) <= 0.02, `got ${net}`);
    await updateSettings({ cardSurchargePercent: 0 });
  }

  // ---------------------------------------------------- 12. Debt stays USD, paid in EUR
  {
    const c = await mkClient("Debtor");
    const debt = await makeDebt(c.id, 400, "Balance owed");
    ok("debt is created in USD", debt.currency === "USD" && debt.amount === 400);
    ok("nothing paid yet", debt.paidAmount === 0 && debt.outstandingAmount === 400);

    // €200 = $217.39 -> partial.
    await clearClientDebt(debt.id, {
      method: "cash",
      tender: [{ method: "cash", currency: "EUR", amount: 200 }],
    });
    let row = (await listClientDebts(c.id))[0];
    ok("€200 part-pays the debt", row.paidAmount === 217.39, `paid=${row.paidAmount}`);
    ok("≈$182.61 remains", row.outstandingAmount === 182.61, `remaining=${row.outstandingAmount}`);
    ok("the debt is STILL outstanding and still $400 principal in USD",
       row.status === "outstanding" && row.amount === 400 && row.currency === "USD");

    // Changing the rate must not move the debt. 0.92 -> 0.5 is a large enough
    // jump to trip the suspicious-rate guard, so it is confirmed explicitly —
    // which is exactly what an admin would have to do.
    await updateSettings({ usdToEur: 0.5, confirmSuspicious: { usdToEur: 0.5 } });
    row = (await listClientDebts(c.id))[0];
    ok("a rate change does not re-price the debt principal",
       row.amount === 400 && row.outstandingAmount === 182.61,
       `amount=${row.amount} remaining=${row.outstandingAmount}`);
    // Restoring it is the same size of jump, so it needs its own confirmation.
    await updateSettings({ usdToEur: USD_TO_EUR, confirmSuspicious: { usdToEur: USD_TO_EUR } });

    // Overpaying the remainder is refused.
    let over = "";
    try {
      await clearClientDebt(debt.id, {
        method: "cash",
        tender: [{ method: "cash", currency: "EUR", amount: 300 }], // $326.09 > $182.61
      });
    } catch (e) { over = (e as Error).message; }
    ok("over-collecting a debt is refused (no credit balances)",
       over.includes("too much"), over || "no error");
    ok("the refused attempt changed nothing",
       (await listClientDebts(c.id))[0].paidAmount === 217.39);

    // The exact remainder in LBP clears it.
    const lbpForRest = Math.round(182.61 * USD_TO_LBP);
    await clearClientDebt(debt.id, {
      method: "cash",
      tender: [{ method: "cash", currency: "LBP", amount: lbpForRest }],
    });
    row = (await listClientDebts(c.id))[0];
    ok("paying the rest in LBP clears the debt", row.status === "cleared", row.status);
    ok("paidAmount snaps to the principal", row.paidAmount === 400 && row.outstandingAmount === 0,
       `paid=${row.paidAmount}`);
    ok("a cleared debt can't be collected again",
       await clearClientDebt(debt.id, { method: "cash" }).then(() => false, () => true));
  }

  // ------------------------------------------- 13. Debt: legacy full-clear path unchanged
  {
    const c = await mkClient("LegacyDebt");
    const debt = await makeDebt(c.id, 75, "Legacy");
    await clearClientDebt(debt.id, { method: "cash" });
    const row = (await listClientDebts(c.id))[0];
    const pay = await db.payment.findFirstOrThrow({ where: { clientId: c.id } });
    ok("no-tender clear still collects the whole balance in USD",
       row.status === "cleared" && pay.amountPaid === 75 && pay.currency === "USD" && pay.fxRate === 1,
       `${pay.amountPaid} ${pay.currency}`);
  }

  // --------------------------------------------------------------- 14. Race: one settlement
  {
    const c = await mkClient("Racer");
    const b = await billFor(c.id, doc.id, 250);
    const attempt = () =>
      settleVisitBasket(b.id, {
        splits: [{ method: "cash", currency: "EUR", amount: 230 }],
        actorName: "Sec",
      }).then(() => "ok", (e: Error) => e.message);
    const [a, d] = await Promise.all([attempt(), attempt()]);
    const wins = [a, d].filter((r) => r === "ok").length;
    ok("exactly one of two concurrent settlements succeeds", wins === 1, `${a} | ${d}`);
    const pays = await db.payment.findMany({ where: { visitBasketId: b.id } });
    ok("exactly one payment row was written", pays.length === 1,
       JSON.stringify(pays.map((p) => [p.currency, p.amountPaid])));
    ok("the basket is settled exactly once",
       (await db.visitBasket.findUniqueOrThrow({ where: { id: b.id } })).status === "paid");
  }

  // ------------------------------------------------- 15. DB constraints are the last line
  {
    let blocked = false;
    try {
      await db.payment.create({
        data: { motif: "x", amountPaid: 1, currency: "GBP", method: "cash", receiptNumber: "RCP-BAD-1" },
      });
    } catch { blocked = true; }
    ok("the DB refuses an unsupported payment currency", blocked);

    blocked = false;
    try {
      await db.payment.create({
        data: { motif: "x", amountPaid: 1, currency: "EUR", method: "cash", receiptNumber: "RCP-BAD-2" },
      });
    } catch { blocked = true; }
    ok("the DB refuses a EUR payment with no frozen rate", blocked);

    blocked = false;
    try {
      await db.payment.create({
        data: { motif: "x", amountPaid: 1, currency: "EUR", fxRate: 0, method: "cash", receiptNumber: "RCP-BAD-3" },
      });
    } catch { blocked = true; }
    ok("the DB refuses a non-positive fxRate", blocked);

    const c = await mkClient("Constraint");
    const debt = await makeDebt(c.id, 50, "c");
    blocked = false;
    try {
      await db.clientDebt.update({ where: { id: debt.id }, data: { paidAmount: 500 } });
    } catch { blocked = true; }
    ok("the DB refuses paidAmount above the principal", blocked);
    blocked = false;
    try {
      await db.clientDebt.update({ where: { id: debt.id }, data: { paidAmount: -1 } });
    } catch { blocked = true; }
    ok("the DB refuses a negative paidAmount", blocked);
  }

  await db.$disconnect();
}

main();
