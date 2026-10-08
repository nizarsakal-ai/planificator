/**
 * Module Tâches V1 — Cœur testable de la création (hors fichier "use server").
 *
 * Toutes les dépendances externes (session, lecture du compte, transaction Prisma,
 * revalidation) sont injectées : la logique d'autorisation, d'isolation tenant et
 * d'enchaînement vérifications → création est prouvable sans base de données.
 *
 * Invariants imposés par le serveur (jamais issus du client) :
 *  - companyId provient du compte vérifié ;
 *  - createdById est le userId de la session vérifiée ;
 *  - assigneeId / worksiteId sont vérifiés dans la MÊME transaction que l'insertion,
 *    filtrés par companyId (et active pour l'employé).
 */

import type { Role } from "@prisma/client"
import {
  parseCreateTaskInput,
  type NormalizedTaskInput,
  type TaskPriority,
  type TaskStatus,
} from "@/lib/tasks/task.schema"

export type TaskActor = {
  id: string
  active: boolean
  role: Role
  companyId: string | null
  /** État de l'entreprise rattachée (relation), ou null si aucune entreprise. */
  company: { active: boolean } | null
}

export type CreateTaskOutcome =
  | "FORBIDDEN"
  | "INVALID"
  | "REFERENCE"
  | "CONFLICT"
  | "ERROR"

export type CreateTaskResult =
  | { ok: true; task: { id: string } }
  | { ok: false; outcome: CreateTaskOutcome; message: string }

/** Données d'insertion construites explicitement côté serveur (aucun spread du payload). */
export type TaskCreateData = {
  companyId: string
  createdById: string
  title: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  dueDate: Date | null
  assigneeId: string | null
  worksiteId: string | null
}

/** Client de transaction : vérifications de références + insertion, tenant-filtrées. */
export type TaskCreateTx = {
  /** Employé actif du même tenant, ou null. */
  findEmployee: (args: { id: string; companyId: string }) => Promise<{ id: string } | null>
  /** Chantier du même tenant, ou null. */
  findWorksite: (args: { id: string; companyId: string }) => Promise<{ id: string } | null>
  createTask: (data: TaskCreateData) => Promise<{ id: string }>
}

export type CreateTaskDeps = {
  auth: () => Promise<{ user?: { id?: string | null } | null } | null>
  loadAccount: (userId: string) => Promise<TaskActor | null>
  runInTransaction: <T>(fn: (tx: TaskCreateTx) => Promise<T>) => Promise<T>
  revalidate: () => void
  isSerializationConflict?: (err: unknown) => boolean
}

export const FORBIDDEN_MESSAGE = "Accès refusé."
export const EMPLOYEE_NOT_FOUND_MESSAGE =
  "L'employé assigné est introuvable dans votre entreprise."
export const WORKSITE_NOT_FOUND_MESSAGE =
  "Le chantier sélectionné est introuvable dans votre entreprise."
export const CONFLICT_MESSAGE =
  "La tâche n'a pas pu être enregistrée, veuillez réessayer."

/** Prisma signale un échec de sérialisation / write-conflict via le code P2034. */
export function defaultIsSerializationConflict(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const code = (err as { code?: unknown }).code
  return code === "P2034"
}

/**
 * Politique d'autorisation (V1) : création réservée aux administrateurs actifs
 * d'une entreprise ACTIVE. SUPER_ADMIN n'est autorisé que lorsqu'il possède une
 * entreprise (et uniquement dans cette entreprise). Aucun privilège global implicite.
 * Une entreprise inexistante ou désactivée (`Company.active = false`) refuse la création.
 */
export function authorizeTaskCreation(
  account: TaskActor | null
): { ok: true; companyId: string } | { ok: false } {
  if (!account) return { ok: false }
  if (!account.active) return { ok: false }
  if (account.role !== "ADMIN" && account.role !== "SUPER_ADMIN") return { ok: false }
  if (!account.companyId) return { ok: false }
  // L'entreprise doit exister et être active (vérification côté serveur).
  if (!account.company || account.company.active !== true) return { ok: false }
  return { ok: true, companyId: account.companyId }
}

export async function createTaskCore(
  input: unknown,
  deps: CreateTaskDeps
): Promise<CreateTaskResult> {
  // 1. Session
  const session = await deps.auth()
  const sessionUserId = session?.user?.id
  if (!sessionUserId) return { ok: false, outcome: "FORBIDDEN", message: FORBIDDEN_MESSAGE }
  const userId: string = sessionUserId

  // 2. Relecture du compte (identité réelle, pas celle de la session)
  const account = await deps.loadAccount(userId)

  // 3. Autorisation + entreprise active
  const authz = authorizeTaskCreation(account)
  if (!authz.ok) return { ok: false, outcome: "FORBIDDEN", message: FORBIDDEN_MESSAGE }
  const companyId = authz.companyId

  // 4. Validation des entrées
  const parsed = parseCreateTaskInput(input)
  if (!parsed.ok) return { ok: false, outcome: "INVALID", message: parsed.message }
  const data: NormalizedTaskInput = parsed.data

  // 5-6. Vérifications de références + insertion dans UNE transaction.
  try {
    type TxResult =
      | { kind: "refusal"; message: string }
      | { kind: "created"; task: { id: string } }
    const result: TxResult = await deps.runInTransaction<TxResult>(async (tx) => {
      if (data.assigneeId) {
        const employee = await tx.findEmployee({ id: data.assigneeId, companyId })
        if (!employee) return { kind: "refusal", message: EMPLOYEE_NOT_FOUND_MESSAGE }
      }
      if (data.worksiteId) {
        const worksite = await tx.findWorksite({ id: data.worksiteId, companyId })
        if (!worksite) return { kind: "refusal", message: WORKSITE_NOT_FOUND_MESSAGE }
      }
      const task = await tx.createTask({
        companyId,
        createdById: userId,
        title: data.title,
        description: data.description,
        status: data.status,
        priority: data.priority,
        dueDate: data.dueDate,
        assigneeId: data.assigneeId,
        worksiteId: data.worksiteId,
      })
      return { kind: "created", task }
    })

    if (result.kind === "refusal") {
      return { ok: false, outcome: "REFERENCE", message: result.message }
    }

    // 7. Revalidation uniquement après succès réel.
    deps.revalidate()
    return { ok: true, task: result.task }
  } catch (err) {
    const isConflict = deps.isSerializationConflict ?? defaultIsSerializationConflict
    if (isConflict(err)) {
      return { ok: false, outcome: "CONFLICT", message: CONFLICT_MESSAGE }
    }
    return { ok: false, outcome: "ERROR", message: CONFLICT_MESSAGE }
  }
}
