-- AlterTable
ALTER TABLE "VisitBasket" ADD COLUMN     "machineVisitId" TEXT;

-- CreateTable
CREATE TABLE "MachineVisit" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "recordedById" TEXT,
    "recordedByName" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'recorded',
    "appointmentId" TEXT,
    "idempotencyKey" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidedByName" TEXT,
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MachineVisit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MachineVisitItem" (
    "id" TEXT NOT NULL,
    "machineVisitId" TEXT NOT NULL,
    "machine" TEXT NOT NULL,
    "sessions" INTEGER NOT NULL,
    "sessionPlanId" TEXT,
    "clientPackageId" TEXT,
    "billedSessions" INTEGER NOT NULL DEFAULT 0,
    "unitPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MachineVisitItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MachineVisit_idempotencyKey_key" ON "MachineVisit"("idempotencyKey");

-- CreateIndex
CREATE INDEX "MachineVisit_clientId_idx" ON "MachineVisit"("clientId");

-- CreateIndex
CREATE INDEX "MachineVisit_date_idx" ON "MachineVisit"("date");

-- CreateIndex
CREATE INDEX "MachineVisitItem_machineVisitId_idx" ON "MachineVisitItem"("machineVisitId");

-- CreateIndex
CREATE INDEX "MachineVisitItem_sessionPlanId_idx" ON "MachineVisitItem"("sessionPlanId");

-- CreateIndex
CREATE INDEX "MachineVisitItem_clientPackageId_idx" ON "MachineVisitItem"("clientPackageId");

-- CreateIndex
CREATE INDEX "VisitBasket_machineVisitId_idx" ON "VisitBasket"("machineVisitId");

-- AddForeignKey
ALTER TABLE "VisitBasket" ADD CONSTRAINT "VisitBasket_machineVisitId_fkey" FOREIGN KEY ("machineVisitId") REFERENCES "MachineVisit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineVisit" ADD CONSTRAINT "MachineVisit_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineVisit" ADD CONSTRAINT "MachineVisit_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineVisit" ADD CONSTRAINT "MachineVisit_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineVisit" ADD CONSTRAINT "MachineVisit_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineVisitItem" ADD CONSTRAINT "MachineVisitItem_machineVisitId_fkey" FOREIGN KEY ("machineVisitId") REFERENCES "MachineVisit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineVisitItem" ADD CONSTRAINT "MachineVisitItem_sessionPlanId_fkey" FOREIGN KEY ("sessionPlanId") REFERENCES "SessionPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineVisitItem" ADD CONSTRAINT "MachineVisitItem_clientPackageId_fkey" FOREIGN KEY ("clientPackageId") REFERENCES "ClientPackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Integrity constraints Prisma cannot express (hand-written — do not lose these
-- if migrations are ever squashed; see docs/known-issues.md).
-- ---------------------------------------------------------------------------

-- A machine visit item consumes from EXACTLY ONE prepaid source: a pay-as-you-go
-- SessionPlan or a fixed-price ClientPackage. Neither (an unsourced consumption)
-- nor both (an ambiguous one that a void could reverse twice) may exist.
ALTER TABLE "MachineVisitItem"
  ADD CONSTRAINT "MachineVisitItem_one_source"
  CHECK (num_nonnulls("sessionPlanId", "clientPackageId") = 1);

-- Consumption is always positive, and what was billed can never exceed what was
-- consumed (billing is driven by the sessions this visit could not cover from
-- prepaid credit, so it is bounded by them).
ALTER TABLE "MachineVisitItem"
  ADD CONSTRAINT "MachineVisitItem_sessions_positive" CHECK ("sessions" > 0);
ALTER TABLE "MachineVisitItem"
  ADD CONSTRAINT "MachineVisitItem_billed_within_sessions"
  CHECK ("billedSessions" >= 0 AND "billedSessions" <= "sessions");

-- Only the two real machine-visit states exist.
ALTER TABLE "MachineVisit"
  ADD CONSTRAINT "MachineVisit_status_valid"
  CHECK ("status" IN ('recorded', 'voided'));

-- A voided visit always carries its attribution; a live one never does. Keeps
-- "voided" from being a bare flag with no accountability behind it.
ALTER TABLE "MachineVisit"
  ADD CONSTRAINT "MachineVisit_void_attribution"
  CHECK (
    ("status" = 'voided' AND "voidedAt" IS NOT NULL AND "voidedByName" IS NOT NULL)
    OR ("status" = 'recorded' AND "voidedAt" IS NULL)
  );

-- Session counters are counts: they can never go negative, whichever code path
-- moves them. The last line of defence under a lost update or a bad manual write.
-- NOTE: `sessionsUsed <= sessionsNeeded` is deliberately NOT asserted on
-- SessionPlan — the consultation editor lets a dietitian record more sessions
-- delivered than the plan currently calls for (sessionsNeeded is a purchase
-- intent, not a hard ceiling), and existing rows are allowed to sit that way.
-- The machine-visit path enforces the ceiling itself, in application code.
ALTER TABLE "SessionPlan"
  ADD CONSTRAINT "SessionPlan_counts_non_negative"
  CHECK ("sessionsNeeded" >= 0 AND "sessionsUsed" >= 0 AND "sessionsPaid" >= 0);

-- A bundle is a fixed quantity: usage is bounded by what was bought. Every code
-- path already holds this (coverage is allocated against the remaining balance);
-- the constraint makes it true of the table.
ALTER TABLE "ClientPackage"
  ADD CONSTRAINT "ClientPackage_sessions_within_total"
  CHECK ("totalSessions" >= 0 AND "usedSessions" >= 0 AND "usedSessions" <= "totalSessions");
