-- C-BOOK-001 — Cycle de vie ProcessedGmailMessage (Booking uniquement).
-- Migration additive. Lignes historiques → SUCCEEDED (déjà consommées).
-- Rollback logique : laisser les colonnes/enums ; ne pas DROP en production.

CREATE TYPE "BookingGmailMessageStatus" AS ENUM (
    'PROCESSING',
    'SUCCEEDED',
    'RETRYABLE_FAILURE',
    'PERMANENTLY_IGNORED'
);

CREATE TYPE "BookingGmailResultType" AS ENUM (
    'ACCOMMODATION',
    'PENDING_ACCOMMODATION',
    'CANCELLATION',
    'IGNORED'
);

ALTER TABLE "processed_gmail_messages" ADD COLUMN "status" "BookingGmailMessageStatus" NOT NULL DEFAULT 'SUCCEEDED';
ALTER TABLE "processed_gmail_messages" ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "processed_gmail_messages" ADD COLUMN "firstAttemptAt" TIMESTAMP(3);
ALTER TABLE "processed_gmail_messages" ADD COLUMN "lastAttemptAt" TIMESTAMP(3);
ALTER TABLE "processed_gmail_messages" ADD COLUMN "nextRetryAt" TIMESTAMP(3);
ALTER TABLE "processed_gmail_messages" ADD COLUMN "succeededAt" TIMESTAMP(3);
ALTER TABLE "processed_gmail_messages" ADD COLUMN "errorCode" TEXT;
ALTER TABLE "processed_gmail_messages" ADD COLUMN "errorMessage" TEXT;
ALTER TABLE "processed_gmail_messages" ADD COLUMN "resultType" "BookingGmailResultType";
ALTER TABLE "processed_gmail_messages" ADD COLUMN "resultEntityId" TEXT;
ALTER TABLE "processed_gmail_messages" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "processed_gmail_messages"
SET
    "status" = 'SUCCEEDED',
    "succeededAt" = COALESCE("succeededAt", "processedAt"),
    "attemptCount" = CASE WHEN "attemptCount" = 0 THEN 1 ELSE "attemptCount" END,
    "firstAttemptAt" = COALESCE("firstAttemptAt", "processedAt"),
    "lastAttemptAt" = COALESCE("lastAttemptAt", "processedAt"),
    "updatedAt" = "processedAt";

CREATE INDEX "processed_gmail_messages_status_nextRetryAt_idx"
    ON "processed_gmail_messages"("status", "nextRetryAt");

CREATE INDEX "processed_gmail_messages_status_lastAttemptAt_idx"
    ON "processed_gmail_messages"("status", "lastAttemptAt");
