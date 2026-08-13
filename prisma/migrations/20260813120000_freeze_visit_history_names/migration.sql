-- Freeze the names a closed visit displays.
--
-- A closed visit is a finalized historical record, but two of the labels the
-- Visit Summary shows were resolved through live relations every time it was
-- read: the dietitian's name (User.fullName) and the bundle's name
-- (ClientPackage.packageName). Renaming a staff member therefore rewrote the
-- doctor's name on every past visit they ever ran.
--
-- These columns hold the value as of the moment the visit closed. They stay NULL
-- while a visit is open — an editable draft has no history to preserve, so it
-- reads the live relation and picks up a correction immediately.
ALTER TABLE "Consultation" ADD COLUMN "dietitianNameSnapshot" TEXT;
ALTER TABLE "ConsultationTreatment" ADD COLUMN "packageNameSnapshot" TEXT;

-- Backfill already-closed visits. The name each record carries today is the best
-- available evidence of what it was called at close; any rename that already
-- happened is unrecoverable, but this stops the drift from here on.
UPDATE "Consultation" c
SET "dietitianNameSnapshot" = u."fullName"
FROM "User" u
WHERE c."dietitianId" = u."id" AND c."status" = 'closed';

UPDATE "ConsultationTreatment" t
SET "packageNameSnapshot" = cp."packageName"
FROM "ClientPackage" cp, "Consultation" c
WHERE t."clientPackageId" = cp."id"
  AND t."consultationId" = c."id"
  AND c."status" = 'closed';
