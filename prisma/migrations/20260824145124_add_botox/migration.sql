-- DropForeignKey
ALTER TABLE "VisitBasketItem" DROP CONSTRAINT "VisitBasketItem_clientPackageId_fkey";

-- DropIndex
DROP INDEX "Client_referrerId_idx";

-- DropIndex
DROP INDEX "VisitBasketItem_clientPackageId_idx";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "canOfferBotox" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "VisitBasketItem" ADD COLUMN     "consultationBotoxItemId" TEXT;

-- CreateTable
CREATE TABLE "BotoxItem" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotoxItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsultationBotoxItem" (
    "id" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "botoxItemId" TEXT,
    "name" TEXT NOT NULL,
    "basePrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "chargedPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "unitCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsultationBotoxItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConsultationBotoxItem_consultationId_idx" ON "ConsultationBotoxItem"("consultationId");

-- CreateIndex
CREATE INDEX "VisitBasketItem_consultationBotoxItemId_idx" ON "VisitBasketItem"("consultationBotoxItemId");

-- AddForeignKey
ALTER TABLE "ConsultationBotoxItem" ADD CONSTRAINT "ConsultationBotoxItem_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "Consultation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsultationBotoxItem" ADD CONSTRAINT "ConsultationBotoxItem_botoxItemId_fkey" FOREIGN KEY ("botoxItemId") REFERENCES "BotoxItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitBasketItem" ADD CONSTRAINT "VisitBasketItem_clientPackageId_fkey" FOREIGN KEY ("clientPackageId") REFERENCES "ClientPackage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitBasketItem" ADD CONSTRAINT "VisitBasketItem_consultationBotoxItemId_fkey" FOREIGN KEY ("consultationBotoxItemId") REFERENCES "ConsultationBotoxItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
