-- AlterTable
ALTER TABLE "User" ADD COLUMN     "totpBackupCodes" TEXT NOT NULL DEFAULT '[]',
ADD COLUMN     "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "totpSecret" TEXT;

-- CreateTable
CREATE TABLE "PendingTwoFactor" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingTwoFactor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PendingTwoFactor_tokenHash_key" ON "PendingTwoFactor"("tokenHash");

-- CreateIndex
CREATE INDEX "PendingTwoFactor_expiresAt_idx" ON "PendingTwoFactor"("expiresAt");

-- AddForeignKey
ALTER TABLE "PendingTwoFactor" ADD CONSTRAINT "PendingTwoFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
