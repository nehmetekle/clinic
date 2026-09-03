-- External Lab Blood Collection: tests outsourced to a third-party lab that
-- bills the clinic one lump sum for the whole group. Money lives on the ORDER;
-- the test lines below it carry no price at all.

-- CreateTable
CREATE TABLE "ConsultationExternalLabOrder" (
    "id" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "totalCostPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalSalePrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "belowCostReason" TEXT,
    "notes" TEXT,
    "pricedByName" TEXT,
    "pricedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsultationExternalLabOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsultationExternalLabTest" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsultationExternalLabTest_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "VisitBasketItem" ADD COLUMN "externalLabOrderId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ConsultationExternalLabOrder_consultationId_key" ON "ConsultationExternalLabOrder"("consultationId");
CREATE INDEX "ConsultationExternalLabTest_orderId_idx" ON "ConsultationExternalLabTest"("orderId");
CREATE INDEX "VisitBasketItem_externalLabOrderId_idx" ON "VisitBasketItem"("externalLabOrderId");

-- AddForeignKey
ALTER TABLE "ConsultationExternalLabOrder" ADD CONSTRAINT "ConsultationExternalLabOrder_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "Consultation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConsultationExternalLabTest" ADD CONSTRAINT "ConsultationExternalLabTest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ConsultationExternalLabOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VisitBasketItem" ADD CONSTRAINT "VisitBasketItem_externalLabOrderId_fkey" FOREIGN KEY ("externalLabOrderId") REFERENCES "ConsultationExternalLabOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- HAND-WRITTEN CONSTRAINTS — Prisma cannot express or introspect these. Do not
-- lose them if the migrations are ever squashed (same warning as the multi-
-- currency and Jessy migrations).
--
-- 1. Neither total may be negative. A negative sale price is a refund, and this
--    app has no refund concept anywhere by design; a negative cost is a lab
--    paying us, which is not a thing. The Zod schema refuses both first — this
--    is the last line of defence against a direct write.
ALTER TABLE "ConsultationExternalLabOrder"
  ADD CONSTRAINT "external_lab_order_totals_nonnegative"
  CHECK ("totalCostPrice" >= 0 AND "totalSalePrice" >= 0);

-- 2. Selling below cost REQUIRES a written reason, enforced by the database and
--    not only by the route. The application refuses it earlier with a readable
--    message; this makes "priced below cost with nobody's justification on
--    record" unrepresentable, however the row is written.
ALTER TABLE "ConsultationExternalLabOrder"
  ADD CONSTRAINT "external_lab_below_cost_needs_reason"
  CHECK (
    "totalSalePrice" >= "totalCostPrice"
    OR ("belowCostReason" IS NOT NULL AND btrim("belowCostReason") <> '')
  );

-- 3. Obligations are USD in this app. Widening this is a deliberate act, not an
--    accident of a stray write.
ALTER TABLE "ConsultationExternalLabOrder"
  ADD CONSTRAINT "external_lab_order_currency_usd"
  CHECK ("currency" = 'USD');
