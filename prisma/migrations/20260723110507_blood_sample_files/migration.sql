-- CreateTable
CREATE TABLE "BloodSampleFile" (
    "id" TEXT NOT NULL,
    "bloodSampleId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "uploadedById" TEXT,
    "uploadedByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BloodSampleFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BloodSampleFile_bloodSampleId_idx" ON "BloodSampleFile"("bloodSampleId");

-- AddForeignKey
ALTER TABLE "BloodSampleFile" ADD CONSTRAINT "BloodSampleFile_bloodSampleId_fkey" FOREIGN KEY ("bloodSampleId") REFERENCES "BloodSample"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BloodSampleFile" ADD CONSTRAINT "BloodSampleFile_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
