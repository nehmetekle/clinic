-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "visitBasketId" TEXT;

-- CreateIndex
CREATE INDEX "Payment_visitBasketId_idx" ON "Payment"("visitBasketId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_visitBasketId_fkey" FOREIGN KEY ("visitBasketId") REFERENCES "VisitBasket"("id") ON DELETE SET NULL ON UPDATE CASCADE;
