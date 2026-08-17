-- ---------------------------------------------------------------------------
-- Sessions must be purchased and SETTLED before they can be used.
--
--   sessionsNeeded — the prescribed course length (clinical intent)
--   sessionsPaid   — sessions purchased AND settled (paid now, or the balance
--                    moved to a ClientDebt); this is the usable supply
--   sessionsUsed   — sessions delivered
--   available      = sessionsPaid - sessionsUsed
--
-- Machine visits consume `available` only and never bill. The one exception is
-- the consultation that PRESCRIBES a course: it may deliver a session before the
-- patient reaches the front desk, so it draws against `sessionsNeeded`. That
-- visit cannot close until its basket is settled, so nothing escapes unpaid —
-- which is why `sessionsUsed <= sessionsPaid` is NOT asserted here.
--
-- These are hand-written checks Prisma can neither express nor introspect. Do not
-- lose them if migrations are ever squashed (see docs/known-issues.md).
-- ---------------------------------------------------------------------------

-- A course can never be prescribed shorter than what has already been bought or
-- delivered. Bring any legacy row up to that floor before asserting it.
UPDATE "SessionPlan"
   SET "sessionsNeeded" = GREATEST("sessionsNeeded", "sessionsPaid", "sessionsUsed");

ALTER TABLE "SessionPlan"
  ADD CONSTRAINT "SessionPlan_bought_within_prescribed"
  CHECK ("sessionsPaid" <= "sessionsNeeded" AND "sessionsUsed" <= "sessionsNeeded");

-- Machine visits are pure consumption now: they raise no basket and bill nothing.
-- Historic rows keep whatever they billed (that money was really collected), so
-- this only forbids NEW non-zero values via the application, not old data.
COMMENT ON COLUMN "MachineVisitItem"."billedSessions" IS
  'Always 0 for visits recorded since sessions became settle-before-use; non-zero only on historic rows.';
