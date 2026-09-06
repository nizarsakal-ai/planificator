-- PLAN-ACQ-PROVIDENCE-DATES-002 — dates chantier inconnues (NULL/NULL)
ALTER TABLE "worksites"
  ALTER COLUMN "startDate" DROP NOT NULL,
  ALTER COLUMN "endDate" DROP NOT NULL;
