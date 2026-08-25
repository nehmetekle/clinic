-- The same client can no longer be double-booked at the same date/time,
-- whether unassigned, assigned to one dietitian, or split across two
-- different dietitians. `activeSlotKey` previously mirrored
-- `clientId|dietitianId|date|time`, which left an unassigned booking
-- (dietitianId IS NULL) and a client double-booked across two different
-- dietitians at the same slot unconstrained. It now mirrors
-- `clientId|date|time`. Always set through `activeSlotKey()` in
-- repositories/appointments.ts — never by hand.

-- Resolve any pre-existing double-bookings under the new, stricter rule:
-- for each clientId/date/time group with more than one active row
-- (regardless of dietitianId — including unassigned), keep the earliest (the
-- original booking) and mark the rest cancelled. Non-destructive — the
-- duplicate rows stay in history with their id and any linked
-- consultation/machine visit intact, they just stop occupying the slot.
UPDATE "Appointment" a
SET "status" = 'cancelled', "activeSlotKey" = NULL
WHERE a."status" IN ('scheduled', 'checked_in', 'with_dietitian')
  AND EXISTS (
    SELECT 1 FROM "Appointment" b
    WHERE b."clientId" = a."clientId"
      AND b."date" = a."date"
      AND b."time" = a."time"
      AND b."status" IN ('scheduled', 'checked_in', 'with_dietitian')
      AND (b."createdAt" < a."createdAt" OR (b."createdAt" = a."createdAt" AND b."id" < a."id"))
  );

-- Recompute activeSlotKey for all still-active rows to the new format —
-- including previously-unassigned bookings, which never had a key before.
UPDATE "Appointment"
SET "activeSlotKey" = "clientId" || '|' || "date" || '|' || "time"
WHERE "status" IN ('scheduled', 'checked_in', 'with_dietitian');
