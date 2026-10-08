-- TÂCHES V1 — Socle du module Tâches (schéma uniquement, strictement additif).
--
-- Contenu : enums "TaskStatus" / "TaskPriority", table "tasks", ses index et ses 3 FK (company, assignee, worksite).
-- Rien d'autre : aucune modification d'une table métier existante, aucun backfill, aucune donnée insérée.
--
-- Multi-tenant : "companyId" NOT NULL, FK vers "companies" ON DELETE CASCADE (les tâches suivent l'entreprise).
-- Références facultatives : "assigneeId" → "employees"("id") et "worksiteId" → "worksites"("id"), toutes deux
-- ON DELETE SET NULL pour préserver la tâche lors des suppressions existantes d'employé / de chantier.
-- "createdById" reste un identifiant scalaire (userId du créateur), sans FK — même choix que worksites/quotes/invoices.
--
-- Atomicité : une seule transaction explicite BEGIN…COMMIT (même contrat que les migrations véhicules).
-- Verrou : création de nouveaux objets uniquement ; aucun ACCESS EXCLUSIVE prolongé sur une table existante.
-- Les FK posées sur "tasks" (table vide nouvellement créée) ne réécrivent aucune table parente.
-- lock_timeout borné à 5 s → échec propre et complet en cas de contention.
--
-- Déploiement : appliquer `prisma migrate deploy` AVANT le code qui lit/écrit "tasks" (Vercel n'exécute pas migrate).
-- `prisma db push` ne rejoue PAS ce fichier. N'utiliser que `prisma migrate deploy` sur les bases partagées.
--
-- Runbook en cas d'échec (NE PAS exécuter sans autorisation) :
--   1. lire l'erreur ; aucune structure de ce lot ne subsiste (transaction atomique) ;
--   2. prisma migrate resolve --rolled-back 20261008120000_tasks_v1
--   3. relancer prisma migrate deploy.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'DONE');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'TODO',
    "priority" "TaskPriority" NOT NULL DEFAULT 'MEDIUM',
    "dueDate" TIMESTAMP(3),
    "assigneeId" TEXT,
    "worksiteId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tasks_companyId_createdAt_idx" ON "tasks"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "tasks_companyId_status_idx" ON "tasks"("companyId", "status");

-- CreateIndex
CREATE INDEX "tasks_assigneeId_idx" ON "tasks"("assigneeId");

-- CreateIndex
CREATE INDEX "tasks_worksiteId_idx" ON "tasks"("worksiteId");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_worksiteId_fkey" FOREIGN KEY ("worksiteId") REFERENCES "worksites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
