-- CreateTable
CREATE TABLE "ConsultationFoodList" (
    "id" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "patientName" TEXT NOT NULL,
    "notes" TEXT,
    "selections" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsultationFoodList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsultationFile" (
    "id" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'food-list',
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "uploadedById" TEXT,
    "uploadedByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsultationFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConsultationFoodList_consultationId_key" ON "ConsultationFoodList"("consultationId");

-- CreateIndex
CREATE INDEX "ConsultationFile_consultationId_idx" ON "ConsultationFile"("consultationId");

-- AddForeignKey
ALTER TABLE "ConsultationFoodList" ADD CONSTRAINT "ConsultationFoodList_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "Consultation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsultationFile" ADD CONSTRAINT "ConsultationFile_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "Consultation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsultationFile" ADD CONSTRAINT "ConsultationFile_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
