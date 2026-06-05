-- CreateTable
CREATE TABLE "signatures" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "signedById" TEXT NOT NULL,
    "signatureUrl" TEXT NOT NULL,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signatures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "signatures_assignmentId_key" ON "signatures"("assignmentId");

-- CreateIndex
CREATE INDEX "signatures_assignmentId_idx" ON "signatures"("assignmentId");

-- CreateIndex
CREATE INDEX "signatures_signedById_idx" ON "signatures"("signedById");

-- AddForeignKey
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_signedById_fkey" FOREIGN KEY ("signedById") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
