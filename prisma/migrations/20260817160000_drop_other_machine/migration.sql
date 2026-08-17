-- Removes the "Other" / custom-machine concept.
--
-- A machine is now always one of the clinic's predefined machines (a
-- ServicePrice row of kind 'treatment') or nothing at all. The free-text
-- `machineOther` escape hatch is gone: it gave one physical machine two possible
-- identities — the catalog key on the machine-visit path, the typed label on the
-- consultation path — so the same machine split into two rows in machine
-- utilization and could never be ranked or totalled correctly.

-- 1. The free-text machine label.
ALTER TABLE "ConsultationTreatment" DROP COLUMN "machineOther";

-- 2. A machine-visit line may legitimately have NO machine (a plan or bundle not
--    tied to one). It used to be stored as the literal 'Treatment' or as the
--    bundle's own name, both of which read as a machine in reporting. NULL now
--    means "no machine" honestly.
ALTER TABLE "MachineVisitItem" ALTER COLUMN "machine" DROP NOT NULL;
UPDATE "MachineVisitItem" SET "machine" = NULL WHERE "machine" = 'Treatment';

-- 3. The catalog's "Other" fallback bucket for TREATMENTS. The blood-test "Other"
--    row is a different kind and stays: a custom one-off lab test is a real thing
--    the clinic orders, whereas a custom machine is not a machine it owns.
DELETE FROM "ServicePrice" WHERE "kind" = 'treatment' AND "key" = 'Other';

-- 4. Rows that named the machine 'Other' are PRE-CUTOVER data with no canonical
--    identity. The true machine was only ever in `machineOther` (consultations)
--    or nowhere at all (session plans, packages, machine visits), so it cannot be
--    reconstructed for every row and is deliberately NOT guessed here. They are
--    left in place and will show as a machine literally named "Other".
--    The database is not yet carrying real clinical data; `npm run db:reset`
--    clears them. Any that are kept must be repointed at a catalog machine by
--    hand.
