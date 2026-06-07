-- CreateEnum
CREATE TYPE "PendingAccommodationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'DISMISSED');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'BOOKING_DETECTED';

-- CreateTable
CREATE TABLE "gmail_connections" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "gmailAddress" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "tokenExpiry" TIMESTAMP(3) NOT NULL,
    "connectedById" TEXT NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gmail_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_gmail_messages" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_gmail_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_accommodations" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "gmailMessageId" TEXT NOT NULL,
    "propertyName" TEXT,
    "address" TEXT,
    "city" TEXT,
    "zipCode" TEXT,
    "startDate" DATE,
    "endDate" DATE,
    "doorCode" TEXT,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "notes" TEXT,
    "rawEmailSnippet" TEXT,
    "status" "PendingAccommodationStatus" NOT NULL DEFAULT 'PENDING',
    "accommodationId" TEXT,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pending_accommodations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gmail_connections_companyId_key" ON "gmail_connections"("companyId");

-- CreateIndex
CREATE INDEX "processed_gmail_messages_companyId_idx" ON "processed_gmail_messages"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "processed_gmail_messages_companyId_messageId_key" ON "processed_gmail_messages"("companyId", "messageId");

-- CreateIndex
CREATE INDEX "pending_accommodations_companyId_idx" ON "pending_accommodations"("companyId");

-- CreateIndex
CREATE INDEX "pending_accommodations_status_idx" ON "pending_accommodations"("status");

-- AddForeignKey
ALTER TABLE "gmail_connections" ADD CONSTRAINT "gmail_connections_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processed_gmail_messages" ADD CONSTRAINT "processed_gmail_messages_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_accommodations" ADD CONSTRAINT "pending_accommodations_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
