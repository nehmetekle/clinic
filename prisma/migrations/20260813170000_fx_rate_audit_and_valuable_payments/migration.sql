-- FX rate audit history + the constraint that removes the historical-rate fallback.
--
-- Additive only. No existing row is rewritten, retyped or deleted, and no
-- historical rate is guessed or backfilled.

-- 1. Append-only history of exchange-rate changes.
--    `Setting` stays the current value; this is how it got there. Every column is
--    server-derived (see the model doc) — nothing is accepted from the client.
CREATE TABLE "FxRateChange" (
  "id"                 TEXT NOT NULL,
  "rateKey"            TEXT NOT NULL,
  "oldValue"           DOUBLE PRECISION,
  "newValue"           DOUBLE PRECISION NOT NULL,
  "suspiciousOverride" BOOLEAN NOT NULL DEFAULT false,
  "changedById"        TEXT,
  "changedByName"      TEXT NOT NULL,
  "changedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FxRateChange_pkey" PRIMARY KEY ("id")
);

-- Newest-first per rate is how the history is always read.
CREATE INDEX "FxRateChange_rateKey_changedAt_idx" ON "FxRateChange"("rateKey", "changedAt");
CREATE INDEX "FxRateChange_changedAt_idx" ON "FxRateChange"("changedAt");

-- The actor link is ON DELETE SET NULL, not CASCADE: deleting a staff member must
-- never erase the record that they changed a rate. `changedByName` is frozen text
-- so the history stays readable after the link is gone.
ALTER TABLE "FxRateChange"
  ADD CONSTRAINT "FxRateChange_changedById_fkey"
  FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Only the two rates the application actually converts with may be recorded, so a
-- typo'd key cannot create a silent parallel history nobody reads.
ALTER TABLE "FxRateChange"
  ADD CONSTRAINT "FxRateChange_rateKey_supported"
  CHECK ("rateKey" IN ('usdToLbp', 'usdToEur'));

-- A recorded rate is always a usable one, so the history can never claim the
-- clinic once converted at 0 or a negative rate.
ALTER TABLE "FxRateChange"
  ADD CONSTRAINT "FxRateChange_values_positive"
  CHECK ("newValue" > 0 AND ("oldValue" IS NULL OR "oldValue" > 0));

-- 2. Every non-USD payment must carry a rate that can value it, FROM ITS OWN ROW.
--    This is what lets `frozenPaymentFxRate` drop its fallback and fail closed:
--    with this in place a payment that cannot be valued cannot exist, so nothing
--    is ever valued at an invented rate.
--
--    ADD CONSTRAINT validates existing rows, so if any historical payment did
--    violate it this migration FAILS LOUDLY at deploy time rather than letting the
--    application quietly mis-value it. That is the intended remediation signal:
--    fix the row, then re-run. (Verified clean on this database before writing:
--    every Payment has usdToLbp > 0 and every write path in the repository's
--    entire history sets it.)
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_valuable"
  CHECK ("currency" = 'USD' OR "fxRate" IS NOT NULL OR "usdToLbp" > 0);
