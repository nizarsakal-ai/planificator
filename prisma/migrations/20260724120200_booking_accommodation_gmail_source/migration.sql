-- C-BOOK-001 — Clé technique Gmail tenant-safe, séparée de bookingReference.
-- Multiple NULL autorisés par PostgreSQL sur l'index unique (NULL ≠ NULL).

ALTER TABLE "accommodations" ADD COLUMN "gmailSourceMessageId" TEXT;

CREATE UNIQUE INDEX "accommodations_companyId_gmailSourceMessageId_key"
  ON "accommodations"("companyId", "gmailSourceMessageId");
