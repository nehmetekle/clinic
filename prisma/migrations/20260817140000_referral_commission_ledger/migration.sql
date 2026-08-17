-- Referral commissions: incurred at the first completed visit, paid separately.
--
-- WHAT CHANGES, IN ONE SENTENCE: registering a patient no longer costs the clinic
-- anything. The obligation is created when that patient's FIRST VISIT COMPLETES,
-- priced at the referrer's rate at that moment, and its later payment is a cash
-- movement that must never be recognized as an expense a second time.
--
-- `Client.referralFee` is DROPPED. It froze a fee at registration, which was the
-- old rule: it recorded a liability for a patient who might never attend, and it
-- locked a rate months before the obligation existed. Keeping the column would
-- leave two sources for one number, which is how a report starts disagreeing with
-- itself. Attribution (`referrerId`, `referrerNameSnapshot`) is unaffected and
-- still frozen at registration — WHO referred the patient is settled then; WHAT
-- they are owed is settled at the first visit.
--
-- No legacy conversion is performed. The database holds test data only, so there
-- is no history to preserve and nothing is derived, inferred or backfilled.

ALTER TABLE "Client" DROP COLUMN "referralFee";

-- Drop the paired-attribution CHECK from the previous migration: it referenced
-- "referralFee", which no longer exists, and the invariant it protected now lives
-- on ReferralCommission (a commission cannot exist without its frozen referrer
-- name, because the column is NOT NULL).
ALTER TABLE "Client" DROP CONSTRAINT IF EXISTS "Client_referrer_attribution_paired";

CREATE TABLE "ReferralPayout" (
  "id"                   TEXT NOT NULL,
  "referrerId"           TEXT,
  "referrerNameSnapshot" TEXT NOT NULL,
  "amount"               DOUBLE PRECISION NOT NULL,
  "reference"            TEXT,
  "notes"                TEXT,
  "paidAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "idempotencyKey"       TEXT,
  "recordedById"         TEXT,
  "recordedByName"       TEXT,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReferralPayout_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReferralCommission" (
  "id"                    TEXT NOT NULL,
  "clientId"              TEXT NOT NULL,
  "referrerId"            TEXT,
  "referrerNameSnapshot"  TEXT NOT NULL,
  "amount"                DOUBLE PRECISION NOT NULL,
  "incurredAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "triggerType"           TEXT NOT NULL,
  "triggerConsultationId" TEXT,
  "triggerMachineVisitId" TEXT,
  "status"                TEXT NOT NULL DEFAULT 'incurred',
  "paidAt"                TIMESTAMP(3),
  "payoutId"              TEXT,
  "voidReason"            TEXT,
  "voidedByName"          TEXT,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReferralCommission_pkey" PRIMARY KEY ("id")
);

-- ONE COMMISSION PER PATIENT, ENFORCED BY THE DATABASE. Two visits completing at
-- the same instant (a close racing a machine visit) both try to mint one; this
-- index is what makes exactly one of them win. It is not a convention the
-- application is trusted to remember — the same reasoning as
-- JessyReceivable.paymentId's unique index.
CREATE UNIQUE INDEX "ReferralCommission_clientId_key" ON "ReferralCommission"("clientId");
CREATE INDEX "ReferralCommission_status_incurredAt_idx" ON "ReferralCommission"("status", "incurredAt");
CREATE INDEX "ReferralCommission_referrerId_idx" ON "ReferralCommission"("referrerId");
CREATE UNIQUE INDEX "ReferralPayout_idempotencyKey_key" ON "ReferralPayout"("idempotencyKey");
CREATE INDEX "ReferralPayout_referrerId_paidAt_idx" ON "ReferralPayout"("referrerId", "paidAt");

-- SetNull throughout: deleting a referrer must never delete the record that the
-- clinic owed (or paid) them money. The frozen name keeps the row attributable.
ALTER TABLE "ReferralCommission" ADD CONSTRAINT "ReferralCommission_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReferralCommission" ADD CONSTRAINT "ReferralCommission_referrerId_fkey"
  FOREIGN KEY ("referrerId") REFERENCES "Referrer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReferralCommission" ADD CONSTRAINT "ReferralCommission_payoutId_fkey"
  FOREIGN KEY ("payoutId") REFERENCES "ReferralPayout"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReferralPayout" ADD CONSTRAINT "ReferralPayout_referrerId_fkey"
  FOREIGN KEY ("referrerId") REFERENCES "Referrer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReferralPayout" ADD CONSTRAINT "ReferralPayout_recordedById_fkey"
  FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written CHECKs Prisma cannot express. Do not lose them in a squash — the
-- same standing rule as the Jessy, multi-currency and session-plan constraints.
--
-- A commission with no money in it is not a commission: a zero-fee referrer must
-- produce NO row rather than a $0 one, so the ledger never carries entries that
-- mean nothing.
ALTER TABLE "ReferralCommission"
  ADD CONSTRAINT "ReferralCommission_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "ReferralPayout"
  ADD CONSTRAINT "ReferralPayout_amount_positive" CHECK ("amount" > 0);

-- "Paid" is not a label that can drift from the facts: a paid commission has both
-- a payment date and the payout that paid it, and an unpaid one has neither.
ALTER TABLE "ReferralCommission"
  ADD CONSTRAINT "ReferralCommission_paid_is_complete" CHECK (
    ("status" = 'paid'  AND "paidAt" IS NOT NULL AND "payoutId" IS NOT NULL) OR
    ("status" <> 'paid' AND "paidAt" IS NULL     AND "payoutId" IS NULL)
  );

ALTER TABLE "ReferralCommission"
  ADD CONSTRAINT "ReferralCommission_status_known" CHECK ("status" IN ('incurred', 'paid', 'void'));

-- Exactly one trigger, matching the declared type. A commission must be able to
-- name the visit that created it, or "incurred at the first completed visit" is
-- unauditable.
ALTER TABLE "ReferralCommission"
  ADD CONSTRAINT "ReferralCommission_trigger_consistent" CHECK (
    ("triggerType" = 'consultation'  AND "triggerConsultationId" IS NOT NULL AND "triggerMachineVisitId" IS NULL) OR
    ("triggerType" = 'machine_visit' AND "triggerMachineVisitId" IS NOT NULL AND "triggerConsultationId" IS NULL)
  );

-- Expense.kind — the safety net against counting a commission twice. Referral
-- payouts never write an Expense row, so this exists only for an expense someone
-- records by hand; tagging it excludes it from operating expenses instead of
-- letting it double-count against the ledger that already recognized it.
ALTER TABLE "Expense" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'operating';
ALTER TABLE "Expense"
  ADD CONSTRAINT "Expense_kind_known" CHECK ("kind" IN ('operating', 'referral_commission'));
