-- PLAN-BOOKING-RELIABILITY-001-R2
-- Clé technique Gmail tenant-safe, séparée de bookingReference (réf. métier Booking.com).
-- Multiple NULL autorisés par PostgreSQL sur l'index unique partiel implicite (NULL ≠ NULL).

ALTER TABLE "accommodations" ADD COLUMN "gmailSourceMessageId" TEXT;

CREATE UNIQUE INDEX "accommodations_companyId_gmailSourceMessageId_key"
  ON "accommodations"("companyId", "gmailSourceMessageId");
