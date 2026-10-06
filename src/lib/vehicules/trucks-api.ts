/**
 * API /api/trucks — logique serveur testable (dépendances injectées : session + accès DB).
 *
 * Durcissement V0 : rôle, entreprise de session obligatoire, validation stricte des payloads,
 * erreurs distinctes. Droits conservés (TEAM_LEADER non restreint à son équipe pour l'instant).
 * Le journal TruckAssignment de PATCH est repris à l'identique.
 */
import type { PrismaClient } from "@prisma/client"
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
export const TRUCKS_DELETE_ROLES = ["SUPER_ADMIN", "ADMIN"] as const

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
  SERVER_ERROR: { status: 500, message: "Erreur serveur" },
}

export function trucksError(code: TrucksErrorCode, issues?: string[]): Response {
  const { status, message } = ERRORS[code]
  return Response.json(issues && issues.length > 0 ? { error: message, code, issues } : { error: message, code }, { status })
}

/** Conflit d'unicité Prisma (P2002) : distingue matricule et équipe ; rien d'autre n'est exposé. */
export function classifyUniqueConflict(err: unknown): "MATRICULE_CONFLICT" | "TEAM_CONFLICT" | null {
  if (!err || typeof err !== "object" || (err as { code?: unknown }).code !== "P2002") return null
  const target = (err as { meta?: { target?: unknown } }).meta?.target
  const fields = Array.isArray(target) ? target.map(String) : typeof target === "string" ? [target] : []
  const joined = fields.join(",")
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
    ;(deps.logError ?? defaultLogError)("GET failed", errorDetails(err))
    return trucksError("SERVER_ERROR")
  }
}

export async function handleTrucksPost(req: Request, deps: TrucksApiDeps): Promise<Response> {
  const access = await requireAccess(deps, TRUCKS_WRITE_ROLES)
  if (!access.ok) return access.response
  const body = await parseBody(req, createTruckSchema)
  if (!body.ok) return body.response
  try {
    const truck = await deps.db.truck.create({
      data: {
        matricule: body.data.matricule,
        marque: body.data.marque ?? null,
        companyId: access.companyId,
      },
    })
    return Response.json(truck)
  } catch (err) {
    const conflict = classifyUniqueConflict(err)
    if (conflict) return trucksError(conflict)
    ;(deps.logError ?? defaultLogError)("POST failed", errorDetails(err))
    return trucksError("SERVER_ERROR")
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
    const existing = await deps.db.truck.findFirst({ where: { id, companyId } })
    if (!existing) return trucksError("TRUCK_NOT_FOUND")

    if (teamId) {
      const team = await deps.db.team.findFirst({ where: { id: teamId, companyId }, select: { id: true } })
      if (!team) return trucksError("TEAM_NOT_FOUND")
    }
    if (chauffeurId) {
      const employee = await deps.db.employee.findFirst({ where: { id: chauffeurId, companyId }, select: { id: true } })
      if (!employee) return trucksError("DRIVER_NOT_FOUND")
    }

    // Nouvelles valeurs effectives après mise à jour
    const nextChauffeurId = chauffeurId !== undefined ? chauffeurId : existing.chauffeurId
    const nextTeamId = teamId !== undefined ? teamId : existing.teamId
    const affectationChanged = nextChauffeurId !== existing.chauffeurId || nextTeamId !== existing.teamId

    const now = new Date()
    const truck = await deps.db.$transaction(async (tx) => {
      // Si le camion est réaffecté à une équipe déjà équipée, libérer
      // l'autre camion et clore son historique.
      if (teamId) {
        const displaced = await tx.truck.findFirst({
          where: { teamId, companyId, id: { not: id } },
          select: { id: true, chauffeurId: true },
        })
        if (displaced) {
          await tx.truck.update({ where: { id: displaced.id }, data: { teamId: null } })
          await tx.truckAssignment.updateMany({
            where: { truckId: displaced.id, endedAt: null },
            data: { endedAt: now },
          })
          await tx.truckAssignment.create({
            data: {
              truckId: displaced.id,
              chauffeurId: displaced.chauffeurId,
              teamId: null,
              companyId,
              startedAt: now,
            },
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

      // Journal : clore la période en cours et en ouvrir une nouvelle
      // reflétant l'état (chauffeur + équipe) après modification.
      if (affectationChanged) {
        await tx.truckAssignment.updateMany({
          where: { truckId: id, endedAt: null },
          data: { endedAt: now },
        })
        await tx.truckAssignment.create({
          data: {
            truckId: id,
            chauffeurId: nextChauffeurId,
            teamId: nextTeamId,
            companyId,
            startedAt: now,
          },
        })
      }

      return updated
    })
    return Response.json(truck)
  } catch (err) {
    const conflict = classifyUniqueConflict(err) ?? classifyVanishedReference(err)
    if (conflict) return trucksError(conflict)
    ;(deps.logError ?? defaultLogError)("PATCH failed", errorDetails(err))
    return trucksError("SERVER_ERROR")
  }
}

export async function handleTruckDelete(id: string, deps: TrucksApiDeps): Promise<Response> {
  const access = await requireAccess(deps, TRUCKS_DELETE_ROLES)
  if (!access.ok) return access.response
  try {
    const { count } = await deps.db.truck.deleteMany({ where: { id, companyId: access.companyId } })
    if (count === 0) return trucksError("TRUCK_NOT_FOUND")
    return Response.json({ ok: true })
  } catch (err) {
    ;(deps.logError ?? defaultLogError)("DELETE failed", errorDetails(err))
    return trucksError("SERVER_ERROR")
  }
}
