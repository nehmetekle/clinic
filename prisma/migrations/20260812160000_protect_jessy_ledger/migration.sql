-- Jessy ledger integrity, enforced by the DATABASE.
--
-- The Jessy receivable ledger has to satisfy one identity at all times:
--
--     recorded - settled = outstanding
--
-- Application code already upholds it (see repositories/jessy.ts), but the
-- ledger is money, so the invariant must survive things the repository never
-- sees: a raw SQL fix, a Prisma Studio edit, a future `payment.delete()`, or a
-- cascade from a client deletion added later. CHECK constraints (added in the
-- previous migration) cover a single row's bounds; these triggers cover the
-- cross-row relationships that a CHECK cannot express.
--
-- NOTE: TRUNCATE does not fire row-level triggers, which is the deliberate
-- escape hatch used to reset the test database (see tests/race/harness.ts).
-- There is no in-app path that needs to bypass these.

-- 1. A receivable's identity and original amount are immutable, and its balance
--    may only ever move DOWN. There is no refund/reversal in this product, so a
--    balance that goes back up is always corruption — it would silently reinvent
--    money Jessy has already transferred.
CREATE OR REPLACE FUNCTION jessy_receivable_guard() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."amount" <> OLD."amount" THEN
    RAISE EXCEPTION 'A Jessy receivable amount is frozen once recorded and cannot be edited.';
  END IF;
  IF NEW."paymentId" <> OLD."paymentId" THEN
    RAISE EXCEPTION 'A Jessy receivable cannot be moved to a different payment.';
  END IF;
  IF NEW."remaining" > OLD."remaining" THEN
    RAISE EXCEPTION 'A Jessy outstanding balance can only go down. Increasing it would double-count money Jessy has already transferred.';
  END IF;
  IF OLD."status" = 'settled' AND NEW."status" <> 'settled' THEN
    RAISE EXCEPTION 'A settled Jessy receivable cannot be reopened.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER jessy_receivable_guard_update
  BEFORE UPDATE ON "JessyReceivable"
  FOR EACH ROW EXECUTE FUNCTION jessy_receivable_guard();

-- 2. A receivable that Jessy has paid against cannot be deleted. This is the one
--    that matters most: deleting it would cascade its allocations away while the
--    JessySettlement kept its full amount, so `settled` would still count money
--    no longer attached to anything and the identity above would break.
--    Because a cascading delete performs a real DELETE on the child row, this
--    also blocks deleting the parent Payment (and any future Client cascade).
--    An UNSETTLED receivable still deletes freely with its payment.
CREATE OR REPLACE FUNCTION jessy_receivable_delete_guard() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "JessySettlementAllocation" WHERE "receivableId" = OLD."id") THEN
    RAISE EXCEPTION 'Jessy has already settled money against this payment, so it cannot be deleted. Deleting it would corrupt the outstanding balance.';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER jessy_receivable_guard_delete
  BEFORE DELETE ON "JessyReceivable"
  FOR EACH ROW EXECUTE FUNCTION jessy_receivable_delete_guard();

-- 3. A recorded transfer from Jessy is permanent and its amount is frozen.
--    Deleting one would leave every receivable it paid off still drawn down,
--    understating what Jessy owes; re-pricing one would desync it from the
--    allocations that add up to it.
CREATE OR REPLACE FUNCTION jessy_settlement_guard() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A recorded Jessy transfer is permanent and cannot be deleted.';
  END IF;
  IF NEW."amount" <> OLD."amount" THEN
    RAISE EXCEPTION 'A recorded Jessy transfer amount is frozen and cannot be edited.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER jessy_settlement_guard_write
  BEFORE UPDATE OR DELETE ON "JessySettlement"
  FOR EACH ROW EXECUTE FUNCTION jessy_settlement_guard();

-- 4. Allocations are the audit trail tying a transfer to the visits it paid off.
--    They are append-only: changing or removing one breaks the link between a
--    settlement's amount and the balances it actually drew down.
CREATE OR REPLACE FUNCTION jessy_allocation_guard() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Jessy settlement allocations are a permanent audit trail and cannot be changed or deleted.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER jessy_allocation_guard_write
  BEFORE UPDATE OR DELETE ON "JessySettlementAllocation"
  FOR EACH ROW EXECUTE FUNCTION jessy_allocation_guard();
