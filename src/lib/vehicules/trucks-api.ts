/**
 * API /api/trucks — logique serveur testable (dépendances injectées : session + accès DB).
 *
 * Durcissement V0 : rôle, entreprise de session obligatoire, validation stricte des payloads,
 * erreurs distinctes. Droits conservés (TEAM_LEADER non restreint à son équipe pour l'instant).
 *
 * V1B — historique fiable et archivage :
 *   - chaque création ouvre une période CREATED ; chaque changement d'affectation clôt la période
 *     ouverte et en ouvre une nouvelle (REASSIGNED / DISPLACED / ARCHIVED / RESTORED) ;
 *   - une période n'est jamais close avant son début (horloges applicatives différentes) ;
 *   - verrou ligne (SELECT … FOR UPDATE) sur les véhicules concernés, pris dans un ordre fixe ;
 *   - archivage atomique : désaffectation équipe + chauffeur, clôture, archivage. DELETE = archivage ;
 *   - nouvelles affectations refusées vers une équipe archivée, un chauffeur inactif ou un véhicule archivé ;
 *     les relations existantes (legacy) ne sont jamais réécrites.
 */
import type { Prisma, PrismaClient, TruckAssignmentReason } from "@prisma/client"
import { z } from "zod"

// ─── Dépendances ─────────────────────────────────────────────────────────────

export type TrucksDb = Pick<PrismaClient, "truck" | "team" | "employee" | "truckAssignment" | "$transaction">

export interface TrucksSession {
  user?: { id?: string | null; role?: string | null; companyId?: string | null } | null
}

export interface TrucksApiDeps {
  auth: () => Promise<TrucksSession | null>
  db: TrucksDb
  /** Journalisation sans message brut (code/nom uniquement). */
  logError?: (context: string, details: Record<string, string | undefined>) => void
}

// ─── Rôles ───────────────────────────────────────────────────────────────────

export const TRUCKS_READ_ROLES = ["SUPER_ADMIN", "ADMIN", "TEAM_LEADER"] as const
export const TRUCKS_WRITE_ROLES = ["SUPER_ADMIN", "ADMIN", "TEAM_LEADER"] as const
/** Archivage / restauration (et DELETE, devenu archivage) : mêmes rôles que l'ancienne suppression. */
export const TRUCKS_ARCHIVE_ROLES = ["SUPER_ADMIN", "ADMIN"] as const

// ─── Erreurs ─────────────────────────────────────────────────────────────────

export type TrucksErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NO_COMPANY"
  | "INVALID_JSON"
  | "INVALID_PAYLOAD"
  | "TRUCK_NOT_FOUND"
  | "TEAM_NOT_FOUND"
  | "DRIVER_NOT_FOUND"
  | "MATRICULE_CONFLICT"
  | "TEAM_CONFLICT"
  | "TRUCK_ARCHIVED"
  | "TRUCK_ARCHIVED_EXISTS"
  | "TEAM_INACTIVE"
  | "DRIVER_INACTIVE"
  | "PERIOD_CONFLICT"
  | "CONCURRENT_UPDATE"
  | "SERVER_ERROR"

const ERRORS: Record<TrucksErrorCode, { status: number; message: string }> = {
  UNAUTHENTICATED: { status: 401, message: "Non authentifié" },
  FORBIDDEN: { status: 403, message: "Accès refusé" },
  NO_COMPANY: { status: 403, message: "Entreprise introuvable pour ce compte" },
  INVALID_JSON: { status: 400, message: "Requête invalide" },
  INVALID_PAYLOAD: { status: 400, message: "Données invalides" },
  TRUCK_NOT_FOUND: { status: 404, message: "Camion introuvable" },
  TEAM_NOT_FOUND: { status: 404, message: "Équipe introuvable" },
  DRIVER_NOT_FOUND: { status: 404, message: "Chauffeur introuvable" },
  MATRICULE_CONFLICT: { status: 409, message: "Matricule déjà existant" },
  TEAM_CONFLICT: { status: 409, message: "Cette équipe vient d'être équipée d'un autre véhicule, réessayez" },
  TRUCK_ARCHIVED: { status: 409, message: "Véhicule archivé : restaurez-le avant de modifier ses affectations" },
  TRUCK_ARCHIVED_EXISTS: {
    status: 409,
    message: "Ce véhicule existe déjà et est archivé : restaurez-le depuis la page Véhicules",
  },
  TEAM_INACTIVE: { status: 409, message: "Équipe archivée : affectation impossible" },
  DRIVER_INACTIVE: { status: 409, message: "Chauffeur inactif : affectation impossible" },
  PERIOD_CONFLICT: { status: 409, message: "Modification concurrente de l'historique du véhicule, réessayez" },
  CONCURRENT_UPDATE: { status: 409, message: "Modification concurrente, réessayez" },
  SERVER_ERROR: { status: 500, message: "Erreur serveur" },
}

export function trucksError(code: TrucksErrorCode, issues?: string[]): Response {
  const { status, message } = ERRORS[code]
  return Response.json(issues && issues.length > 0 ? { error: message, code, issues } : { error: message, code }, { status })
}

/** Conflit d'unicité Prisma (P2002) : matricule, équipe ou période ouverte ; rien d'autre n'est exposé. */
export function classifyUniqueConflict(err: unknown): "MATRICULE_CONFLICT" | "TEAM_CONFLICT" | "PERIOD_CONFLICT" | null {
  if (!err || typeof err !== "object" || (err as { code?: unknown }).code !== "P2002") return null
  const target = (err as { meta?: { target?: unknown } }).meta?.target
  const fields = Array.isArray(target) ? target.map(String) : typeof target === "string" ? [target] : []
  const joined = fields.join(",")
  if (/openForTruckId/i.test(joined)) return "PERIOD_CONFLICT"
  if (/matricule/i.test(joined)) return "MATRICULE_CONFLICT"
  if (/team/i.test(joined)) return "TEAM_CONFLICT"
  return null
}

/**
 * Disparition concurrente entre la vérification et l'écriture (PATCH) :
 * P2025 = enregistrement introuvable ; P2003 = clé étrangère (équipe / chauffeur supprimés).
 */
export function classifyVanishedReference(err: unknown): "TRUCK_NOT_FOUND" | "TEAM_NOT_FOUND" | "DRIVER_NOT_FOUND" | null {
  if (!err || typeof err !== "object") return null
  const { code, meta } = err as { code?: unknown; meta?: { field_name?: unknown } }
  if (code === "P2025") return "TRUCK_NOT_FOUND"
  if (code === "P2003") {
    const field = typeof meta?.field_name === "string" ? meta.field_name : ""
    if (/team/i.test(field)) return "TEAM_NOT_FOUND"
    if (/chauffeur/i.test(field)) return "DRIVER_NOT_FOUND"
  }
  return null
}

/**
 * Violation de la CHECK chronologique (V1B-db : endedAt >= startedAt), reconnue uniquement par le nom de la
 * contrainte dans l'erreur Prisma (P2004) ou PostgreSQL (23514). Toute autre erreur reste inchangée (500).
 */
export function classifyCheckViolation(err: unknown): "PERIOD_CONFLICT" | null {
  if (!err || typeof err !== "object") return null
  const { code, message, meta } = err as {
    code?: unknown
    message?: unknown
    meta?: { code?: unknown; database_error?: unknown; message?: unknown; constraint?: unknown }
  }
  const known = code === "P2004" || code === "23514" || meta?.code === "23514"
  // Prisma peut remonter une CHECK sans code : le nom de la contrainte ET la formulation PostgreSQL sont alors exigés.
  const bare = code === undefined && typeof message === "string" && /violates check constraint/i.test(message)
  if (!known && !bare) return null
  const texts = [message, meta?.database_error, meta?.message, meta?.constraint].filter(
    (v): v is string => typeof v === "string"
  )
  return texts.some((t) => t.includes("truck_assignments_v1b_chronology_check")) ? "PERIOD_CONFLICT" : null
}

function errorDetails(err: unknown): Record<string, string | undefined> {
  if (!err || typeof err !== "object") return { kind: typeof err }
  const e = err as { name?: unknown; code?: unknown }
  return { name: typeof e.name === "string" ? e.name : undefined, code: typeof e.code === "string" ? e.code : undefined }
}

const defaultLogError: NonNullable<TrucksApiDeps["logError"]> = (context, details) => {
  console.error(`[trucks-api] ${context}`, details)
}

// ─── Contexte d'accès ────────────────────────────────────────────────────────

type Access = { ok: true; companyId: string } | { ok: false; response: Response }

async function requireAccess(deps: TrucksApiDeps, roles: readonly string[]): Promise<Access> {
  const session = await deps.auth()
  const user = session?.user
  if (!user) return { ok: false, response: trucksError("UNAUTHENTICATED") }
  if (!user.role || !roles.includes(user.role)) return { ok: false, response: trucksError("FORBIDDEN") }
  const companyId = typeof user.companyId === "string" ? user.companyId.trim() : ""
  if (!companyId) return { ok: false, response: trucksError("NO_COMPANY") }
  return { ok: true, companyId }
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Normalisation actuelle conservée : espaces de bord retirés + majuscules. Pas de fusion AB-123-CD / AB123CD.
 * Pas de longueur maximale : les colonnes historiques sont TEXT sans limite (aucune régression sur l'existant).
 */
const matriculeSchema = z
  .string({ invalid_type_error: "matricule doit être une chaîne" })
  .trim()
  .min(1, "matricule requis")
  .transform((v) => v.toUpperCase())

/** Marque : chaîne vide → null (comportement actuel). Pas de longueur maximale (colonne TEXT). */
const marqueSchema = z
  .string({ invalid_type_error: "marque doit être une chaîne" })
  .trim()
  .nullable()
  .transform((v) => (v ? v : null))

/** Identifiant optionnel : "" ou null → null (désaffectation, comportement actuel). */
const optionalIdSchema = (field: string) =>
  z
    .string({ invalid_type_error: `${field} doit être une chaîne ou null` })
    .trim()
    .max(128, `${field} invalide`)
    .nullable()
    .transform((v) => (v ? v : null))

export const createTruckSchema = z
  .object({
    matricule: matriculeSchema,
    marque: marqueSchema.optional(),
  })
  .strict()

export const updateTruckSchema = z
  .object({
    matricule: matriculeSchema.optional(),
    marque: marqueSchema.optional(),
    teamId: optionalIdSchema("teamId").optional(),
    chauffeurId: optionalIdSchema("chauffeurId").optional(),
  })
  .strict()

type ParseResult<T> = { ok: true; data: T } | { ok: false; response: Response }

async function parseBody<T>(req: Request, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<ParseResult<T>> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return { ok: false, response: trucksError("INVALID_JSON") }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, response: trucksError("INVALID_PAYLOAD") }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
    return { ok: false, response: trucksError("INVALID_PAYLOAD", issues) }
  }
  return { ok: true, data: parsed.data }
}

// ─── Transactions : verrous et périodes ──────────────────────────────────────

type Tx = Prisma.TransactionClient

/** Erreur métier levée dans une transaction (annule tout) puis traduite en réponse HTTP. */
class TrucksApiError extends Error {
  constructor(readonly code: TrucksErrorCode) {
    super(code)
  }
}

/**
 * Verrouille les véhicules du tenant dans un ordre fixe (tri par id) pour éviter tout interblocage
 * entre deux modifications croisées. Renvoie les ids effectivement verrouillés.
 */
async function lockTrucks(tx: Tx, ids: (string | null | undefined)[], companyId: string): Promise<Set<string>> {
  const sorted = [...new Set(ids.filter((v): v is string => !!v))].sort()
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "trucks"
    WHERE "id" = ANY(${sorted}::text[]) AND "companyId" = ${companyId}
    ORDER BY "id"
    FOR UPDATE`
  return new Set(rows.map((r) => r.id))
}

/**
 * Relit sous verrou partagé (FOR SHARE) l'état actif d'une équipe ou d'un employé du tenant :
 * une archivage concurrent attend la fin de la transaction (pas de fenêtre entre contrôle et écriture).
 * Renvoie null si introuvable dans le tenant.
 */
async function readActiveTeam(tx: Tx, id: string, companyId: string): Promise<boolean | null> {
  const rows = await tx.$queryRaw<{ active: boolean }[]>`
    SELECT "active" FROM "teams" WHERE "id" = ${id} AND "companyId" = ${companyId} FOR SHARE`
  return rows.length ? rows[0].active : null
}

async function readActiveEmployee(tx: Tx, id: string, companyId: string): Promise<boolean | null> {
  const rows = await tx.$queryRaw<{ active: boolean }[]>`
    SELECT "active" FROM "employees" WHERE "id" = ${id} AND "companyId" = ${companyId} FOR SHARE`
  return rows.length ? rows[0].active : null
}

/**
 * Clôt la période ouverte du véhicule (s'il y en a une) et en ouvre une nouvelle.
 * L'instant de bascule n'est jamais antérieur au début de la période close (endedAt ≥ startedAt).
 */
async function rotatePeriod(
  tx: Tx,
  args: {
    truckId: string
    companyId: string
    teamId: string | null
    chauffeurId: string | null
    reason: TruckAssignmentReason
    now: Date
  }
): Promise<void> {
  const open = await tx.truckAssignment.findFirst({
    where: { truckId: args.truckId, companyId: args.companyId, endedAt: null },
    select: { id: true, startedAt: true },
  })
  const at = open && open.startedAt.getTime() > args.now.getTime() ? open.startedAt : args.now
  if (open) await tx.truckAssignment.update({ where: { id: open.id }, data: { endedAt: at } })
  await tx.truckAssignment.create({
    data: {
      truckId: args.truckId,
      chauffeurId: args.chauffeurId,
      teamId: args.teamId,
      companyId: args.companyId,
      startedAt: at,
      reason: args.reason,
    },
  })
}

function handleFailure(deps: TrucksApiDeps, context: string, err: unknown): Response {
  if (err instanceof TrucksApiError) return trucksError(err.code)
  // P2028 : transaction expirée (attente de verrou) ; 40P01 : interblocage détecté par PostgreSQL
  // (ex. suppression concurrente d'un employé) → modification concurrente, à réessayer.
  const code = err && typeof err === "object" ? (err as { code?: unknown; meta?: { code?: unknown } }) : null
  if (code && (code.code === "P2028" || code.code === "40P01" || code.meta?.code === "40P01"))
    return trucksError("CONCURRENT_UPDATE")
  const conflict = classifyUniqueConflict(err) ?? classifyCheckViolation(err) ?? classifyVanishedReference(err)
  if (conflict) return trucksError(conflict)
  ;(deps.logError ?? defaultLogError)(context, errorDetails(err))
  return trucksError("SERVER_ERROR")
}

// ─── Handlers ────────────────────────────────────────────────────────────────

export async function handleTrucksGet(deps: TrucksApiDeps): Promise<Response> {
  const access = await requireAccess(deps, TRUCKS_READ_ROLES)
  if (!access.ok) return access.response
  try {
    const trucks = await deps.db.truck.findMany({
      where: { companyId: access.companyId },
      orderBy: { matricule: "asc" },
    })
    return Response.json(trucks)
  } catch (err) {
    return handleFailure(deps, "GET failed", err)
  }
}

export async function handleTrucksPost(req: Request, deps: TrucksApiDeps): Promise<Response> {
  const access = await requireAccess(deps, TRUCKS_WRITE_ROLES)
  if (!access.ok) return access.response
  const { companyId } = access
  const body = await parseBody(req, createTruckSchema)
  if (!body.ok) return body.response
  try {
    const truck = await deps.db.$transaction(async (tx) => {
      const created = await tx.truck.create({
        data: {
          matricule: body.data.matricule,
          marque: body.data.marque ?? null,
          companyId,
        },
      })
      // Période initiale : véhicule connu, sans équipe ni chauffeur.
      await tx.truckAssignment.create({
        data: {
          truckId: created.id,
          chauffeurId: null,
          teamId: null,
          companyId,
          startedAt: created.createdAt,
          reason: "CREATED",
        },
      })
      return created
    })
    return Response.json(truck)
  } catch (err) {
    if (classifyUniqueConflict(err) === "MATRICULE_CONFLICT") {
      try {
        const archived = await deps.db.truck.findFirst({
          where: { companyId, matricule: body.data.matricule, active: false },
          select: { id: true },
        })
        if (archived) return trucksError("TRUCK_ARCHIVED_EXISTS")
      } catch {
        // diagnostic facultatif : on retombe sur le conflit générique
      }
      return trucksError("MATRICULE_CONFLICT")
    }
    return handleFailure(deps, "POST failed", err)
  }
}

export async function handleTruckPatch(req: Request, id: string, deps: TrucksApiDeps): Promise<Response> {
  const access = await requireAccess(deps, TRUCKS_WRITE_ROLES)
  if (!access.ok) return access.response
  const { companyId } = access
  const body = await parseBody(req, updateTruckSchema)
  if (!body.ok) return body.response
  const { teamId, matricule, marque, chauffeurId } = body.data

  try {
    const target = await deps.db.truck.findFirst({ where: { id, companyId }, select: { id: true } })
    if (!target) return trucksError("TRUCK_NOT_FOUND")

    const team = teamId ? await deps.db.team.findFirst({ where: { id: teamId, companyId }, select: { id: true } }) : null
    if (teamId && !team) return trucksError("TEAM_NOT_FOUND")
    const driver = chauffeurId
      ? await deps.db.employee.findFirst({ where: { id: chauffeurId, companyId }, select: { id: true } })
      : null
    if (chauffeurId && !driver) return trucksError("DRIVER_NOT_FOUND")

    // Véhicule actuellement sur l'équipe visée : verrouillé avec la cible (ordre fixe).
    const candidate = teamId
      ? await deps.db.truck.findFirst({ where: { teamId, companyId, id: { not: id } }, select: { id: true } })
      : null

    const truck = await deps.db.$transaction(async (tx) => {
      const locked = await lockTrucks(tx, [id, candidate?.id], companyId)
      if (!locked.has(id)) throw new TrucksApiError("TRUCK_NOT_FOUND")

      // Relecture sous verrou : l'état de départ ne peut plus changer.
      const existing = await tx.truck.findFirst({ where: { id, companyId } })
      if (!existing) throw new TrucksApiError("TRUCK_NOT_FOUND")

      const nextChauffeurId = chauffeurId !== undefined ? chauffeurId : existing.chauffeurId
      const nextTeamId = teamId !== undefined ? teamId : existing.teamId
      const teamChanged = nextTeamId !== existing.teamId
      const driverChanged = nextChauffeurId !== existing.chauffeurId

      // Nouvelles affectations uniquement : une valeur inchangée (legacy) reste acceptée.
      if (!existing.active && (teamChanged || driverChanged)) throw new TrucksApiError("TRUCK_ARCHIVED")
      // Activité relue sous verrou partagé dans la transaction (le contrôle préalable ne sert qu'au 404).
      if (teamChanged && nextTeamId) {
        const active = await readActiveTeam(tx, nextTeamId, companyId)
        if (active === null) throw new TrucksApiError("TEAM_NOT_FOUND")
        if (!active) throw new TrucksApiError("TEAM_INACTIVE")
      }
      if (driverChanged && nextChauffeurId) {
        const active = await readActiveEmployee(tx, nextChauffeurId, companyId)
        if (active === null) throw new TrucksApiError("DRIVER_NOT_FOUND")
        if (!active) throw new TrucksApiError("DRIVER_INACTIVE")
      }

      const now = new Date()

      // Si le camion est réaffecté à une équipe déjà équipée, libérer l'autre camion et tracer.
      if (teamChanged && nextTeamId) {
        const displaced = await tx.truck.findFirst({
          where: { teamId: nextTeamId, companyId, id: { not: id } },
          select: { id: true, chauffeurId: true },
        })
        if (displaced) {
          if (!locked.has(displaced.id)) throw new TrucksApiError("CONCURRENT_UPDATE")
          await tx.truck.update({ where: { id: displaced.id }, data: { teamId: null } })
          await rotatePeriod(tx, {
            truckId: displaced.id,
            companyId,
            teamId: null,
            chauffeurId: displaced.chauffeurId,
            reason: "DISPLACED",
            now,
          })
        }
      }

      const updated = await tx.truck.update({
        where: { id },
        data: {
          ...(matricule !== undefined && { matricule }),
          ...(marque !== undefined && { marque }),
          ...(chauffeurId !== undefined && { chauffeurId }),
          ...(teamId !== undefined && { teamId }),
        },
      })

      if (teamChanged || driverChanged) {
        await rotatePeriod(tx, {
          truckId: id,
          companyId,
          teamId: nextTeamId,
          chauffeurId: nextChauffeurId,
          reason: "REASSIGNED",
          now,
        })
      }

      return updated
    })
    return Response.json(truck)
  } catch (err) {
    return handleFailure(deps, "PATCH failed", err)
  }
}

/**
 * Archivage atomique (idempotent) : désaffectation équipe + chauffeur, clôture de la période ouverte,
 * période ARCHIVED, véhicule inactif. L'historique n'est jamais supprimé.
 */
export async function handleTruckArchive(id: string, deps: TrucksApiDeps): Promise<Response> {
  const access = await requireAccess(deps, TRUCKS_ARCHIVE_ROLES)
  if (!access.ok) return access.response
  const { companyId } = access
  try {
    const result = await deps.db.$transaction(async (tx) => {
      const locked = await lockTrucks(tx, [id], companyId)
      if (!locked.has(id)) throw new TrucksApiError("TRUCK_NOT_FOUND")
      const existing = await tx.truck.findFirst({ where: { id, companyId } })
      if (!existing) throw new TrucksApiError("TRUCK_NOT_FOUND")
      if (!existing.active) return { truck: existing, changed: false }

      const now = new Date()
      await rotatePeriod(tx, { truckId: id, companyId, teamId: null, chauffeurId: null, reason: "ARCHIVED", now })
      const truck = await tx.truck.update({
        where: { id },
        data: { teamId: null, chauffeurId: null, active: false, archivedAt: now },
      })
      return { truck, changed: true }
    })
    return Response.json({ ok: true, archived: true, alreadyArchived: !result.changed, truck: result.truck })
  } catch (err) {
    return handleFailure(deps, "ARCHIVE failed", err)
  }
}

/** Restauration (idempotente) : véhicule actif, sans réaffectation implicite ; période RESTORED. */
export async function handleTruckRestore(id: string, deps: TrucksApiDeps): Promise<Response> {
  const access = await requireAccess(deps, TRUCKS_ARCHIVE_ROLES)
  if (!access.ok) return access.response
  const { companyId } = access
  try {
    const result = await deps.db.$transaction(async (tx) => {
      const locked = await lockTrucks(tx, [id], companyId)
      if (!locked.has(id)) throw new TrucksApiError("TRUCK_NOT_FOUND")
      const existing = await tx.truck.findFirst({ where: { id, companyId } })
      if (!existing) throw new TrucksApiError("TRUCK_NOT_FOUND")
      if (existing.active) return { truck: existing, changed: false }

      const now = new Date()
      await rotatePeriod(tx, { truckId: id, companyId, teamId: null, chauffeurId: null, reason: "RESTORED", now })
      const truck = await tx.truck.update({ where: { id }, data: { active: true, archivedAt: null } })
      return { truck, changed: true }
    })
    return Response.json({ ok: true, restored: true, alreadyActive: !result.changed, truck: result.truck })
  } catch (err) {
    return handleFailure(deps, "RESTORE failed", err)
  }
}

/** DELETE /api/trucks/[id] : plus de suppression physique — archivage (historique conservé). */
export async function handleTruckDelete(id: string, deps: TrucksApiDeps): Promise<Response> {
  return handleTruckArchive(id, deps)
}
