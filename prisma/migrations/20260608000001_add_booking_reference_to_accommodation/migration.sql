-- AlterTable
ALTER TABLE "accommodations" ADD COLUMN "bookingReference" TEXT,
ADD COLUMN "source" TEXT DEFAULT 'manual';

-- CreateIndex
CREATE UNIQUE INDEX "accommodations_bookingReference_key" ON "accommodations"("bookingReference");

-- CreateIndex
CREATE INDEX "accommodations_bookingReference_idx" ON "accommodations"("bookingReference");
