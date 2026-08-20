-- The same client can never be booked twice with the same dietitian at the
-- same date/time. `activeSlotKey` mirrors `clientId|dietitianId|date|time`
-- only while the booking is ACTIVE (scheduled/checked_in/with_dietitian) and
-- only when a dietitian is assigned; Postgres treats NULL as distinct, so
-- terminal-status rows (completed/cancelled/no_show) and unassigned bookings
-- (no dietitian to collide on yet) are unconstrained. Always set through
-- `activeSlotKey()` in repositories/appointments.ts — never by hand.
ALTER TABLE "Appointment" ADD COLUMN "activeSlotKey" TEXT;

-- Resolve any pre-existing double-bookings before the index goes on: for each
-- clientId/dietitianId/date/time group with more than one active row, keep the
-- earliest (the original booking) and mark the rest cancelled. This is
-- non-destructive — the duplicate rows stay in history with their id and any
-- linked consultation/machine visit intact, they just stop occupying the slot.
UPDATE "Appointment" a
SET "status" = 'cancelled'
WHERE a."status" IN ('scheduled', 'checked_in', 'with_dietitian')
  AND a."dietitianId" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "Appointment" b
    WHERE b."clientId" = a."clientId"
      AND b."dietitianId" = a."dietitianId"
      AND b."date" = a."date"
      AND b."time" = a."time"
      AND b."status" IN ('scheduled', 'checked_in', 'with_dietitian')
      AND (b."createdAt" < a."createdAt" OR (b."createdAt" = a."createdAt" AND b."id" < a."id"))
  );

UPDATE "Appointment"
SET "activeSlotKey" = "clientId" || '|' || "dietitianId" || '|' || "date" || '|' || "time"
WHERE "status" IN ('scheduled', 'checked_in', 'with_dietitian')
  AND "dietitianId" IS NOT NULL;

CREATE UNIQUE INDEX "Appointment_activeSlotKey_key"
  ON "Appointment"("activeSlotKey");
