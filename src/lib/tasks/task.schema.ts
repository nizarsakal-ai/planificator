/**
 * Module Tâches V1 — Contrat d'entrée partagé (validation & normalisation).
 *
 * Aucun import d'authentification ni de Prisma connecté : ce fichier est pur et testable.
 * Il valide une entrée brute (objet issu d'un FormData ou d'un test) et produit une entrée
 * normalisée sûre. Les champs réservés imposés côté serveur (companyId, createdById, id,
 * timestamps) sont refusés s'ils sont fournis par le client.
 */

export const TASK_STATUSES = ["TODO", "IN_PROGRESS", "DONE"] as const
export const TASK_PRIORITIES = ["LOW", "MEDIUM", "HIGH"] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]
export type TaskPriority = (typeof TASK_PRIORITIES)[number]

/** Champs imposés par le serveur : jamais acceptés depuis le client. */
export const RESERVED_TASK_FIELDS = [
  "id",
  "companyId",
  "createdById",
  "createdAt",
  "updatedAt",
] as const

export const TITLE_MAX = 200
export const DESCRIPTION_MAX = 5000
/** Borne défensive des identifiants (cuid ≈ 25 car.) pour refuser toute entrée aberrante. */
export const REFERENCE_ID_MAX = 191

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  TODO: "À faire",
  IN_PROGRESS: "En cours",
  DONE: "Terminée",
}

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  LOW: "Basse",
  MEDIUM: "Moyenne",
  HIGH: "Haute",
}

export type NormalizedTaskInput = {
  title: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  dueDate: Date | null
  assigneeId: string | null
  worksiteId: string | null
}

export type ParseResult =
  | { ok: true; data: NormalizedTaskInput }
  | { ok: false; message: string }

type ScalarRead =
  | { kind: "absent" }
  | { kind: "string"; value: string }
  | { kind: "invalid" }

/**
 * Lecture d'un champ scalaire depuis l'entrée brute.
 * - clé absente / null / undefined → absent
 * - chaîne → string (non coercée)
 * - tableau (doublon FormData), fichier, nombre, booléen, objet → invalide
 */
function readScalar(raw: Record<string, unknown>, key: string): ScalarRead {
  if (!(key in raw)) return { kind: "absent" }
  const v = raw[key]
  if (v === null || v === undefined) return { kind: "absent" }
  if (typeof v === "string") return { kind: "string", value: v }
  return { kind: "invalid" }
}

/** Date calendaire stricte `YYYY-MM-DD` → minuit UTC. Null si format ou date impossible. */
export function parseDueDateYmd(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const dt = new Date(Date.UTC(year, month - 1, day))
  // Rejette les dates impossibles normalisées par Date (ex. 2026-02-30 → 2026-03-02).
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return null
  }
  return dt
}

/**
 * Valide et normalise une entrée brute de création de tâche.
 * N'applique les valeurs par défaut que lorsque le champ est absent.
 */
export function parseCreateTaskInput(input: unknown): ParseResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "Entrée invalide." }
  }
  const raw = input as Record<string, unknown>

  // Champs réservés : refusés dès qu'ils sont fournis par le client (même vides).
  // Seule une clé réellement absente (ou null/undefined) est tolérée.
  for (const key of RESERVED_TASK_FIELDS) {
    if (readScalar(raw, key).kind !== "absent") {
      return { ok: false, message: "Champ non autorisé." }
    }
  }

  // Titre (obligatoire)
  const titleRead = readScalar(raw, "title")
  if (titleRead.kind !== "string") {
    return { ok: false, message: "Le titre est requis." }
  }
  const title = titleRead.value.trim()
  if (title.length === 0) return { ok: false, message: "Le titre est requis." }
  if (title.length > TITLE_MAX) {
    return { ok: false, message: `Le titre ne peut pas dépasser ${TITLE_MAX} caractères.` }
  }

  // Description (facultative) — vide → null
  const descRead = readScalar(raw, "description")
  if (descRead.kind === "invalid") {
    return { ok: false, message: "Description invalide." }
  }
  let description: string | null = null
  if (descRead.kind === "string") {
    const trimmed = descRead.value.trim()
    if (trimmed.length > DESCRIPTION_MAX) {
      return { ok: false, message: `La description ne peut pas dépasser ${DESCRIPTION_MAX} caractères.` }
    }
    description = trimmed.length === 0 ? null : trimmed
  }

  // Statut — enum exact ; défaut TODO uniquement si le champ est absent.
  // Un champ présent (même vide ou entouré d'espaces) doit valoir exactement un enum.
  const statusRead = readScalar(raw, "status")
  if (statusRead.kind === "invalid") return { ok: false, message: "Statut invalide." }
  let status: TaskStatus = "TODO"
  if (statusRead.kind === "string") {
    if (!(TASK_STATUSES as readonly string[]).includes(statusRead.value)) {
      return { ok: false, message: "Statut invalide." }
    }
    status = statusRead.value as TaskStatus
  }

  // Priorité — enum exact ; défaut MEDIUM uniquement si le champ est absent.
  const priorityRead = readScalar(raw, "priority")
  if (priorityRead.kind === "invalid") return { ok: false, message: "Priorité invalide." }
  let priority: TaskPriority = "MEDIUM"
  if (priorityRead.kind === "string") {
    if (!(TASK_PRIORITIES as readonly string[]).includes(priorityRead.value)) {
      return { ok: false, message: "Priorité invalide." }
    }
    priority = priorityRead.value as TaskPriority
  }

  // Échéance (facultative) — vide → null ; sinon date calendaire stricte
  const dueRead = readScalar(raw, "dueDate")
  if (dueRead.kind === "invalid") return { ok: false, message: "Échéance invalide." }
  let dueDate: Date | null = null
  if (dueRead.kind === "string" && dueRead.value.trim() !== "") {
    const parsed = parseDueDateYmd(dueRead.value.trim())
    if (!parsed) return { ok: false, message: "Échéance invalide." }
    dueDate = parsed
  }

  // Référence employé (facultative)
  const assigneeRead = readScalar(raw, "assigneeId")
  if (assigneeRead.kind === "invalid") {
    return { ok: false, message: "Employé assigné invalide." }
  }
  let assigneeId: string | null = null
  if (assigneeRead.kind === "string") {
    const trimmed = assigneeRead.value.trim()
    if (trimmed.length > 0) {
      if (trimmed.length > REFERENCE_ID_MAX) {
        return { ok: false, message: "Employé assigné invalide." }
      }
      assigneeId = trimmed
    }
  }

  // Référence chantier (facultative)
  const worksiteRead = readScalar(raw, "worksiteId")
  if (worksiteRead.kind === "invalid") {
    return { ok: false, message: "Chantier invalide." }
  }
  let worksiteId: string | null = null
  if (worksiteRead.kind === "string") {
    const trimmed = worksiteRead.value.trim()
    if (trimmed.length > 0) {
      if (trimmed.length > REFERENCE_ID_MAX) {
        return { ok: false, message: "Chantier invalide." }
      }
      worksiteId = trimmed
    }
  }

  return {
    ok: true,
    data: { title, description, status, priority, dueDate, assigneeId, worksiteId },
  }
}

/**
 * Convertit un FormData en objet brut pour `parseCreateTaskInput`.
 * Un champ présent plusieurs fois devient un tableau → refusé en aval (doublon).
 * Les valeurs non textuelles (fichiers) sont conservées telles quelles → refusées en aval.
 */
export function taskFormDataToRaw(formData: FormData): Record<string, unknown> {
  const raw: Record<string, unknown> = {}
  for (const key of new Set(formData.keys())) {
    const all = formData.getAll(key)
    raw[key] = all.length > 1 ? all : all[0]
  }
  return raw
}
