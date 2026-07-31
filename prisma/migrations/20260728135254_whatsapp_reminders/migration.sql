-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "reminder24hSentAt" TIMESTAMP(3),
ADD COLUMN     "reminder2hSentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "whatsappOptIn" BOOLEAN NOT NULL DEFAULT true;
