-- The appointment a consultation is fulfilling. Closing the visit completes THIS
-- booking and nothing else; before this column, a close completed every live
-- appointment the patient had, so a patient booked twice on one day had both
-- closed out by a single visit.
--
-- Nullable and left NULL for every existing row: a historical visit has no
-- appointment to attribute, and the close path falls back to completing a single
-- unambiguous live appointment (never several) when the link is absent.
ALTER TABLE "Consultation" ADD COLUMN "appointmentId" TEXT;

ALTER TABLE "Consultation" ADD CONSTRAINT "Consultation_appointmentId_fkey"
  FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Consultation_appointmentId_idx" ON "Consultation"("appointmentId");
