-- Freeze the referrer a commission is owed to, and stop grouping money by a
-- mutable field (audit finding F-07).
--
-- `Client.referralFee` has always been frozen at registration. `referralSource`
-- — the field every referrer report GROUPS BY — was not: `updateClient` rewrites
-- it freely (a check-in or profile correction), and does so with no audit trail
-- at all. The combination meant a corrected referrer moved a frozen commission
-- onto a referrer who never earned it, at a rate that was never theirs, with
-- nothing recording that it had happened.
--
-- These two columns are the immutable counterpart of `referralFee`: captured by
-- the same event, at the same instant, and never rewritten afterwards.
--
--   referrerNameSnapshot — the durable one. Survives the referrer being renamed
--                          or deleted; this is what reporting groups by.
--   referrerId           — the precise link, for the cases a name cannot
--                          disambiguate. Nulled if that referrer is deleted,
--                          which is why the name is stored separately.
--
-- NO BACKFILL. For patients registered before this migration the original
-- referrer is unrecoverable: `referralSource` may already have been edited, and
-- because client edits were never audited there is no record of what it was.
-- Copying today's `referralSource` into the snapshot would manufacture a
-- provenance that does not exist and would freeze the very error this migration
-- exists to stop. Pre-cutover rows therefore keep NULL and reporting falls back
-- to `referralSource` for them, which is honest about being a current value
-- rather than a historical one. See docs/known-issues.md §8.

ALTER TABLE "Client" ADD COLUMN "referrerNameSnapshot" TEXT;
ALTER TABLE "Client" ADD COLUMN "referrerId" TEXT;

CREATE INDEX "Client_referrerId_idx" ON "Client"("referrerId");

-- SetNull, not Cascade: a commission that was incurred must survive the referrer
-- being removed from the dropdown. The name snapshot keeps it attributable.
ALTER TABLE "Client"
  ADD CONSTRAINT "Client_referrerId_fkey"
  FOREIGN KEY ("referrerId") REFERENCES "Referrer"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
