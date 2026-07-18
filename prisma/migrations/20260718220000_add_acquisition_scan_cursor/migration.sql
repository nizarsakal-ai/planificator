-- CreateTable
CREATE TABLE "acquisition_scan_cursors" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "source" "AcquisitionSource" NOT NULL,
    "lastHistoryId" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acquisition_scan_cursors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "acquisition_scan_cursors_companyId_source_key" ON "acquisition_scan_cursors"("companyId", "source");

-- AddForeignKey
ALTER TABLE "acquisition_scan_cursors" ADD CONSTRAINT "acquisition_scan_cursors_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
