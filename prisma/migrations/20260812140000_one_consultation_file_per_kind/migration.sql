-- One current ConsultationFile per (consultation, kind).
--
-- Until now this was only an assumption in application code: saveConsultationFile
-- did find -> delete -> create, so two generators racing (the doctor pressing
-- "Generate PDF" while closing the visit auto-generates) could both insert and
-- leave a visit with two Food List PDFs.
--
-- Any duplicates already in the data are collapsed to the most recent row first,
-- which is the one the app has been treating as current all along.
DELETE FROM "ConsultationFile" a
USING "ConsultationFile" b
WHERE a."consultationId" = b."consultationId"
  AND a."kind" = b."kind"
  AND (a."createdAt", a."id") < (b."createdAt", b."id");

CREATE UNIQUE INDEX "ConsultationFile_consultationId_kind_key"
  ON "ConsultationFile"("consultationId", "kind");
