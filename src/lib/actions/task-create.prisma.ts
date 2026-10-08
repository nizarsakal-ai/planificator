/**
 * Module Tâches V1 — Adaptateur Prisma de la création (hors "use server", testable avec mock).
 *
 * Isolé du fichier "use server" afin de prouver, dans les tests, les filtres réellement
 * construits : employé filtré par (id, companyId, active:true), chantier par (id, companyId),
 * insertion dans une transaction Serializable, lecture du compte à sélection minimale.
 */

import { Prisma } from "@prisma/client"
import type { CreateTaskDeps, TaskActor, TaskCreateData } from "@/lib/actions/task-create.core"

/** Surface minimale de Prisma requise par l'adaptateur (facilite le mock en test). */
export type TaskPrismaClient = {
  user: {
    findUnique: (args: {
      where: { id: string }
      select: {
        id: true
        active: true
        role: true
        companyId: true
        company: { select: { active: true } }
      }
    }) => Promise<TaskActor | null>
  }
  employee: {
    findFirst: (args: {
      where: { id: string; companyId: string; active: true }
      select: { id: true }
    }) => Promise<{ id: string } | null>
  }
  worksite: {
    findFirst: (args: {
      where: { id: string; companyId: string }
      select: { id: true }
    }) => Promise<{ id: string } | null>
  }
  task: {
    create: (args: { data: TaskCreateData; select: { id: true } }) => Promise<{ id: string }>
  }
  $transaction: <T>(
    fn: (tx: {
      employee: TaskPrismaClient["employee"]
      worksite: TaskPrismaClient["worksite"]
      task: TaskPrismaClient["task"]
    }) => Promise<T>,
    options?: { isolationLevel?: unknown }
  ) => Promise<T>
}

/**
 * Construit les dépendances Prisma du cœur de création.
 * `revalidate` et `auth` sont injectés par le fichier "use server".
 */
export function buildPrismaTaskDeps(
  client: TaskPrismaClient,
  auth: CreateTaskDeps["auth"],
  revalidate: () => void
): CreateTaskDeps {
  return {
    auth,
    revalidate,
    loadAccount: (userId) =>
      client.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          active: true,
          role: true,
          companyId: true,
          company: { select: { active: true } },
        },
      }),
    runInTransaction: (fn) =>
      client.$transaction(
        (tx) =>
          fn({
            findEmployee: ({ id, companyId }) =>
              tx.employee.findFirst({
                where: { id, companyId, active: true },
                select: { id: true },
              }),
            findWorksite: ({ id, companyId }) =>
              tx.worksite.findFirst({
                where: { id, companyId },
                select: { id: true },
              }),
            createTask: (data) => tx.task.create({ data, select: { id: true } }),
          }),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      ),
  }
}
