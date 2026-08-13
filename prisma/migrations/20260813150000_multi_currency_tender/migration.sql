-- Multi-currency TENDER (USD / EUR / LBP) for a USD-denominated bill.
--
-- Accounting invariant this migration is built around:
--   obligations (baskets, debts, plans, prices, the Jessy ledger) stay USD;
--   only PAYMENTS may be tendered in another currency.
--
-- Purely additive and reversible: no column is renamed, retyped or dropped, and
-- no existing value changes meaning. Every pre-existing Payment is USD or LBP and
-- keeps being valued through `usdToLbp` exactly as before (fxRate stays NULL for
-- them — see frozenPaymentFxRate in src/lib/money.ts).

-- 1. Frozen per-payment FX rate: units of the payment's own currency per 1 USD.
--    NULL on legacy rows by design; NOT backfilled, because backfilling USD rows
--    with the LBP rate would be meaningless and backfilling LBP rows would only
--    duplicate a snapshot that is already correct.
ALTER TABLE "Payment" ADD COLUMN "fxRate" DOUBLE PRECISION;

-- 2. USD collected against a client debt, enabling PARTIAL settlement. Needed
--    because foreign tender rarely lands on the exact balance (€200 against a
--    $400 debt leaves $182.61). Defaults to 0 = every existing debt is untouched.
ALTER TABLE "ClientDebt" ADD COLUMN "paidAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- 3. Storage-level fail-closed guards. Prisma cannot express CHECK constraints,
--    so — like the Jessy ledger's — these are hand-written and must survive any
--    future migration squash.
--
--    A payment currency outside the supported set can never exist, so no report
--    can ever meet a row it cannot value. A non-positive/NULL-but-present rate
--    can never exist, so no row can produce Infinity/NaN/$0 on conversion.
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_currency_supported"
  CHECK ("currency" IN ('USD', 'EUR', 'LBP'));

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_fxRate_positive"
  CHECK ("fxRate" IS NULL OR "fxRate" > 0);

--    A non-USD payment written from now on MUST carry its frozen rate. Legacy
--    rows are exempted by currency: only EUR is unconditionally required, because
--    EUR did not exist before this migration, so an EUR row without a rate is
--    corruption rather than history.
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_eur_requires_fxRate"
  CHECK ("currency" <> 'EUR' OR "fxRate" IS NOT NULL);

--    Obligations stay USD/LBP-denominated. This is the constraint that stops a
--    future code path from quietly turning a bill into a EUR obligation.
ALTER TABLE "ClientDebt"
  ADD CONSTRAINT "ClientDebt_currency_supported"
  CHECK ("currency" IN ('USD', 'LBP'));

--    Collected can never go negative, and can never exceed the principal by more
--    than a rounding cent (the app refuses overpayment; this is the last line of
--    defence, mirroring the Jessy ledger's `remaining BETWEEN 0 AND amount`).
ALTER TABLE "ClientDebt"
  ADD CONSTRAINT "ClientDebt_paidAmount_bounded"
  CHECK ("paidAmount" >= 0 AND "paidAmount" <= "amount" + 0.005);
