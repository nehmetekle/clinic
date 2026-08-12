-- One ACTIVE session plan per client per machine, enforced by the database.
-- `activeMachineKey` mirrors `machine` only while status = 'active'; Postgres
-- treats NULL as distinct, so completed/cancelled plans are unconstrained.
ALTER TABLE "SessionPlan" ADD COLUMN "activeMachineKey" TEXT;

-- Clean up any pre-existing duplicate active plans that never carried money or
-- usage (harmless empties) before the index goes on. A duplicate that DID carry
-- money is left alone on purpose: the index creation then fails loudly rather
-- than silently discarding a client's paid balance.
UPDATE "SessionPlan" p
SET "status" = 'cancelled'
WHERE p."status" = 'active'
  AND p."machine" IS NOT NULL
  AND p."sessionsPaid" = 0
  AND p."sessionsUsed" = 0
  AND EXISTS (
    SELECT 1 FROM "SessionPlan" q
    WHERE q."clientId" = p."clientId"
      AND q."machine" = p."machine"
      AND q."status" = 'active'
      AND (q."createdAt" > p."createdAt" OR (q."createdAt" = p."createdAt" AND q."id" > p."id"))
  );

UPDATE "SessionPlan"
SET "activeMachineKey" = "machine"
WHERE "status" = 'active' AND "machine" IS NOT NULL;

CREATE UNIQUE INDEX "SessionPlan_clientId_activeMachineKey_key"
  ON "SessionPlan"("clientId", "activeMachineKey");
