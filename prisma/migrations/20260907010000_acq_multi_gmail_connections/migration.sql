-- PLAN-ACQ-MULTI-GMAIL-001 — Connexions Gmail multi-compte Acquisition (additive).
-- Ne touche pas gmail_connections (Booking).

-- CreateTable
CREATE TABLE "acquisition_gmail_connections" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "gmailAddress" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "tokenExpiry" TIMESTAMP(3) NOT NULL,
    "connectedById" TEXT NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "acquisition_gmail_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "acquisition_gmail_connections_companyId_gmailAddress_key" ON "acquisition_gmail_connections"("companyId", "gmailAddress");

-- CreateIndex
CREATE INDEX "acquisition_gmail_connections_companyId_active_idx" ON "acquisition_gmail_connections"("companyId", "active");

-- AddForeignKey
ALTER TABLE "acquisition_gmail_connections" ADD CONSTRAINT "acquisition_gmail_connections_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable acquisition_scan_cursors — isolation curseur par boîte
ALTER TABLE "acquisition_scan_cursors" ADD COLUMN "mailboxKey" TEXT NOT NULL DEFAULT '';

DROP INDEX "acquisition_scan_cursors_companyId_source_key";

CREATE UNIQUE INDEX "acquisition_scan_cursors_companyId_source_mailboxKey_key" ON "acquisition_scan_cursors"("companyId", "source", "mailboxKey");

CREATE INDEX "acquisition_scan_cursors_companyId_source_idx" ON "acquisition_scan_cursors"("companyId", "source");

-- AlterTable acquisition_messages — isolation message id par boîte
ALTER TABLE "acquisition_messages" ADD COLUMN "sourceMailboxKey" TEXT NOT NULL DEFAULT '';

DROP INDEX "acquisition_messages_companyId_source_externalMessageId_key";

CREATE UNIQUE INDEX "acquisition_messages_companyId_source_sourceMailboxKey_externalMessageId_key" ON "acquisition_messages"("companyId", "source", "sourceMailboxKey", "externalMessageId");

CREATE INDEX "acquisition_messages_companyId_sourceMailboxKey_idx" ON "acquisition_messages"("companyId", "sourceMailboxKey");
