-- CreateTable
CREATE TABLE "JessyReceivable" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "clientId" TEXT,
    "consultationId" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "remaining" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'outstanding',
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JessyReceivable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JessySettlement" (
    "id" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "idempotencyKey" TEXT,
    "recordedById" TEXT,
    "recordedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JessySettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JessySettlementAllocation" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "receivableId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JessySettlementAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JessyReceivable_paymentId_key" ON "JessyReceivable"("paymentId");

-- CreateIndex
CREATE INDEX "JessyReceivable_status_createdAt_idx" ON "JessyReceivable"("status", "createdAt");

-- CreateIndex
CREATE INDEX "JessyReceivable_clientId_idx" ON "JessyReceivable"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "JessySettlement_idempotencyKey_key" ON "JessySettlement"("idempotencyKey");

-- CreateIndex
CREATE INDEX "JessySettlementAllocation_settlementId_idx" ON "JessySettlementAllocation"("settlementId");

-- CreateIndex
CREATE INDEX "JessySettlementAllocation_receivableId_idx" ON "JessySettlementAllocation"("receivableId");

-- AddForeignKey
ALTER TABLE "JessyReceivable" ADD CONSTRAINT "JessyReceivable_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JessyReceivable" ADD CONSTRAINT "JessyReceivable_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JessyReceivable" ADD CONSTRAINT "JessyReceivable_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "Consultation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JessySettlement" ADD CONSTRAINT "JessySettlement_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JessySettlementAllocation" ADD CONSTRAINT "JessySettlementAllocation_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "JessySettlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JessySettlementAllocation" ADD CONSTRAINT "JessySettlementAllocation_receivableId_fkey" FOREIGN KEY ("receivableId") REFERENCES "JessyReceivable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Balance safety net, enforced by the DATABASE rather than only by application
-- code: a Jessy receivable can never be over-settled into a negative balance,
-- and never "un-settled" back above what was originally owed. If a bug or a
-- concurrent write ever tried, the transaction aborts instead of silently
-- corrupting the outstanding figure. Prisma has no schema syntax for CHECK
-- constraints, so these are hand-written here (introspection ignores them).
ALTER TABLE "JessyReceivable" ADD CONSTRAINT "JessyReceivable_remaining_within_amount"
  CHECK ("remaining" >= 0 AND "remaining" <= "amount");
ALTER TABLE "JessyReceivable" ADD CONSTRAINT "JessyReceivable_amount_positive"
  CHECK ("amount" > 0);
-- A settlement (and each of its allocations) always moves money in one direction.
ALTER TABLE "JessySettlement" ADD CONSTRAINT "JessySettlement_amount_positive"
  CHECK ("amount" > 0);
ALTER TABLE "JessySettlementAllocation" ADD CONSTRAINT "JessySettlementAllocation_amount_positive"
  CHECK ("amount" > 0);
