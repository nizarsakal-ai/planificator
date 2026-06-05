-- CreateEnum
CREATE TYPE "WeatherCondition" AS ENUM ('SUNNY', 'CLOUDY', 'RAINY', 'STORMY', 'WINDY', 'SNOW');

-- CreateTable
CREATE TABLE "daily_reports" (
    "id" TEXT NOT NULL,
    "worksiteId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "weather" "WeatherCondition" NOT NULL DEFAULT 'SUNNY',
    "description" TEXT NOT NULL,
    "issues" TEXT,
    "hoursWorked" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "daily_reports_worksiteId_idx" ON "daily_reports"("worksiteId");

-- CreateIndex
CREATE INDEX "daily_reports_teamId_idx" ON "daily_reports"("teamId");

-- CreateIndex
CREATE INDEX "daily_reports_date_idx" ON "daily_reports"("date");

-- CreateIndex
CREATE INDEX "daily_reports_createdById_idx" ON "daily_reports"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "daily_reports_teamId_date_key" ON "daily_reports"("teamId", "date");

-- AddForeignKey
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_worksiteId_fkey" FOREIGN KEY ("worksiteId") REFERENCES "worksites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
