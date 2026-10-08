/** Vehicles V2 — domaine kilométrique pur, indépendant de Prisma et des autorisations. */
import { createHash } from "node:crypto"
import { z } from "zod"

export const MAX_MILEAGE = 9_999_999
export const MAX_MILEAGE_REVISION = 2_147_483_647

export class MileageDomainError extends Error {
  constructor(readonly code: string, readonly status = 409) {
    super(code)
    this.name = "MileageDomainError"
  }
}

export type MileageCommandType = "READING" | "START" | "END" | "CORRECTION"
export type MileageOriginalKind = "READING" | "DEPARTURE" | "ARRIVAL"
export type MileageEntryKind = MileageOriginalKind | "CORRECTION"

const mileageSchema = z.number().int().min(0).max(MAX_MILEAGE)
const revisionSchema = z.number().int().min(0).max(MAX_MILEAGE_REVISION)
const idSchema = z.string().trim().min(1).max(200)
const occurredAtSchema = z.string().datetime({ offset: true })
  .refine((value) => Number.isFinite(new Date(value).getTime()))
  .transform((value) => new Date(value))
const originalFields = {
  mileage: mileageSchema,
  expectedRevision: revisionSchema,
  occurredAt: occurredAtSchema.optional(),
}
const readingSchema = z.object(originalFields).strict()
const startSchema = z.object({ ...originalFields, worksiteId: idSchema.nullable().optional() }).strict()
const endSchema = z.object({ ...originalFields, tripId: idSchema }).strict()
const correctionSchema = z.object({
  mileage: mileageSchema,
  expectedRevision: revisionSchema,
  entryId: idSchema,
  expectedEffectiveEntryId: idSchema,
  reason: z.string().trim().min(1),
}).strict()

type CommandBase = { idempotencyKey: string }
export type MileageCommand = CommandBase & (
  | ({ type: "READING" } & z.infer<typeof readingSchema>)
  | ({ type: "START" } & z.infer<typeof startSchema>)
  | ({ type: "END" } & z.infer<typeof endSchema>)
  | ({ type: "CORRECTION" } & z.infer<typeof correctionSchema>)
)

/** Le type vient de la commande serveur; tenant, auteur et contexte ne viennent jamais du payload. */
export function parseMileageCommand(
  type: MileageCommandType,
  body: unknown,
  idempotencyKey: string | null | undefined,
): MileageCommand {
  const key = z.string().trim().uuid().safeParse(idempotencyKey)
  if (!key.success) throw new MileageDomainError("INVALID_IDEMPOTENCY_KEY", 400)
  const normalizedKey = key.data.toLowerCase()
  switch (type) {
    case "READING": {
      const parsed = readingSchema.safeParse(body)
      if (!parsed.success) throw new MileageDomainError("INVALID_PAYLOAD", 400)
      return { type, ...parsed.data, idempotencyKey: normalizedKey }
    }
    case "START": {
      const parsed = startSchema.safeParse(body)
      if (!parsed.success) throw new MileageDomainError("INVALID_PAYLOAD", 400)
      return { type, ...parsed.data, worksiteId: parsed.data.worksiteId ?? null, idempotencyKey: normalizedKey }
    }
    case "END": {
      const parsed = endSchema.safeParse(body)
      if (!parsed.success) throw new MileageDomainError("INVALID_PAYLOAD", 400)
      return { type, ...parsed.data, idempotencyKey: normalizedKey }
    }
    case "CORRECTION": {
      const parsed = correctionSchema.safeParse(body)
      if (!parsed.success) throw new MileageDomainError("INVALID_PAYLOAD", 400)
      return { type, ...parsed.data, idempotencyKey: normalizedKey }
    }
    default:
      throw new MileageDomainError("INVALID_PAYLOAD", 400)
  }
}

export interface MileageRequestScope {
  companyId: string
  truckId: string
  actorId: string
}

/**
 * Empreinte versionnée d'une commande normalisée. L'absence de date reste un marqueur
 * stable : la date serveur choisie lors du premier appel ne change pas un replay.
 * La clé est volontairement hors empreinte : elle identifie déjà la demande stockée.
 */
export function computeMileageRequestHash(command: MileageCommand, scope: MileageRequestScope): string {
  const target = command.type === "END" ? command.tripId
    : command.type === "CORRECTION" ? command.entryId : null
  const canonical = [
    "vehicles-mileage-v2:1", scope.companyId, scope.truckId, scope.actorId,
    command.type, command.mileage, command.expectedRevision, target,
    command.type === "CORRECTION" ? command.expectedEffectiveEntryId : null,
    command.type === "CORRECTION" ? command.reason : null,
    command.type === "START" ? command.worksiteId ?? null : null,
    command.type === "CORRECTION" ? "NO_NEW_OBSERVATION"
      : command.occurredAt?.toISOString() ?? "SERVER_TIME_ON_FIRST_WRITE",
  ]
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex")
}

export interface MileageEntryRecord {
  id: string
  companyId: string
  truckId: string
  kind: MileageEntryKind
  mileage: number
  revision: number
  occurredAt: Date | null
  rootEntryId: string | null
  supersedesEntryId: string | null
  correctionReason: string | null
}

export interface MileageOriginalRecord extends MileageEntryRecord {
  kind: MileageOriginalKind
  occurredAt: Date
  rootEntryId: null
  supersedesEntryId: null
  correctionReason: null
}

export interface MileageTripRecord {
  id: string
  companyId: string
  truckId: string
  startEntryId: string
  endEntryId: string | null
}

export interface MileageProjection {
  currentMileage: number | null
  currentMileageEntryId: string | null
  mileageRevision: number
}

export interface ResolvedMileageOriginal {
  original: MileageOriginalRecord
  effective: MileageEntryRecord
}

export interface ResolvedMileageHistory {
  originals: ResolvedMileageOriginal[]
  byOriginalId: Map<string, ResolvedMileageOriginal>
  byEntryId: Map<string, MileageEntryRecord>
  projection: MileageProjection
}

function corrupt(): never {
  throw new MileageDomainError("MILEAGE_HISTORY_CORRUPT", 500)
}

function validMileage(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_MILEAGE
}

function validInstant(value: Date | null): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime())
}

/**
 * Reçoit TOUT le journal d'un seul véhicule. Les révisions sont les commandes réussies,
 * pas un ordre chronologique des corrections. Les valeurs effectives finales sont
 * comparées dans l'ordre des observations originales, jamais selon la date de correction.
 */
export function resolveMileageHistory(entries: readonly MileageEntryRecord[]): ResolvedMileageHistory {
  const byEntryId = new Map<string, MileageEntryRecord>()
  const byOriginalId = new Map<string, ResolvedMileageOriginal>()
  const originals: ResolvedMileageOriginal[] = []
  const ordered = [...entries].sort((a, b) => a.revision - b.revision)
  const scope = ordered[0]
  let previousOriginal: MileageOriginalRecord | undefined

  for (const [index, entry] of ordered.entries()) {
    if (!entry.id || !entry.companyId || !entry.truckId || byEntryId.has(entry.id)
      || entry.companyId !== scope.companyId || entry.truckId !== scope.truckId
      || entry.revision !== index + 1 || entry.revision > MAX_MILEAGE_REVISION
      || !validMileage(entry.mileage)) corrupt()

    if (entry.kind === "CORRECTION") {
      if (entry.occurredAt !== null || !entry.rootEntryId || !entry.supersedesEntryId
        || typeof entry.correctionReason !== "string" || !entry.correctionReason.trim()) corrupt()
      const resolved = byOriginalId.get(entry.rootEntryId)
      if (!resolved || resolved.effective.id !== entry.supersedesEntryId) corrupt()
      resolved.effective = entry
    } else {
      if (!["READING", "DEPARTURE", "ARRIVAL"].includes(entry.kind)
        || !validInstant(entry.occurredAt) || entry.rootEntryId !== null
        || entry.supersedesEntryId !== null || entry.correctionReason !== null) corrupt()
      const original = entry as MileageOriginalRecord
      if (previousOriginal && original.occurredAt.getTime() < previousOriginal.occurredAt.getTime()) corrupt()
      const resolved = { original, effective: entry }
      originals.push(resolved)
      byOriginalId.set(entry.id, resolved)
      previousOriginal = original
    }
    byEntryId.set(entry.id, entry)
  }

  originals.sort((a, b) => a.original.occurredAt.getTime() - b.original.occurredAt.getTime()
    || a.original.revision - b.original.revision)
  for (let index = 1; index < originals.length; index++) {
    if (originals[index].effective.mileage < originals[index - 1].effective.mileage) corrupt()
  }
  const latest = originals[originals.length - 1]
  return {
    originals, byOriginalId, byEntryId,
    projection: {
      currentMileage: latest?.effective.mileage ?? null,
      currentMileageEntryId: latest?.effective.id ?? null,
      mileageRevision: ordered.length,
    },
  }
}

export function rebuildMileageProjection(entries: readonly MileageEntryRecord[]): MileageProjection {
  return resolveMileageHistory(entries).projection
}

/** Les originaux restent appendus dans l'ordre métier, avec égalité d'instant autorisée. */
export function validateNewOriginal(
  history: ResolvedMileageHistory,
  mileage: number,
  occurredAt: Date,
  now: Date,
): void {
  if (!validMileage(mileage) || !validInstant(occurredAt) || !validInstant(now)) {
    throw new MileageDomainError("INVALID_PAYLOAD", 400)
  }
  if (occurredAt.getTime() > now.getTime()) throw new MileageDomainError("MILEAGE_FUTURE_DATE", 422)
  const latest = history.originals[history.originals.length - 1]
  if (latest && occurredAt.getTime() < latest.original.occurredAt.getTime()) {
    throw new MileageDomainError("MILEAGE_OUT_OF_ORDER")
  }
  if (latest && mileage < latest.effective.mileage) throw new MileageDomainError("MILEAGE_REGRESSION")
}

function resolveTripEntries(history: ResolvedMileageHistory, trip: MileageTripRecord) {
  const start = history.byOriginalId.get(trip.startEntryId)
  const end = trip.endEntryId === null ? null : history.byOriginalId.get(trip.endEntryId)
  if (!start || start.original.kind !== "DEPARTURE"
    || start.original.companyId !== trip.companyId || start.original.truckId !== trip.truckId
    || (trip.endEntryId !== null && (!end || end.original.kind !== "ARRIVAL"
      || end.original.companyId !== trip.companyId || end.original.truckId !== trip.truckId
      || end.original.revision <= start.original.revision
      || end.original.occurredAt.getTime() < start.original.occurredAt.getTime()))) corrupt()
  return { start, end: end ?? null }
}

/** Distance calculée à la lecture depuis les bouts effectifs; null tant que le trajet est ouvert. */
export function getMileageTripDistance(history: ResolvedMileageHistory, trip: MileageTripRecord): number | null {
  const { start, end } = resolveTripEntries(history, trip)
  if (!end) return null
  const distance = end.effective.mileage - start.effective.mileage
  if (distance < 0) corrupt()
  return distance
}

export interface MileageCorrectionCandidate {
  /** Un original ou une correction de sa chaîne; le service persiste toujours la racine originale. */
  entryId: string
  expectedEffectiveEntryId: string
  mileage: number
}

/** Contrôle la tête attendue, les voisins chronologiques et tous les trajets concernés. */
export function validateMileageCorrection(
  history: ResolvedMileageHistory,
  candidate: MileageCorrectionCandidate,
  trips: readonly MileageTripRecord[],
): ResolvedMileageOriginal {
  if (!validMileage(candidate.mileage)) throw new MileageDomainError("INVALID_PAYLOAD", 400)
  const target = history.byEntryId.get(candidate.entryId)
  if (!target) throw new MileageDomainError("MILEAGE_ENTRY_NOT_FOUND", 404)
  const rootId = target.kind === "CORRECTION" ? target.rootEntryId! : target.id
  const resolved = history.byOriginalId.get(rootId)
  if (!resolved) corrupt()
  if (resolved.effective.id !== candidate.expectedEffectiveEntryId) {
    throw new MileageDomainError("MILEAGE_CORRECTION_CONFLICT")
  }
  const index = history.originals.findIndex((entry) => entry.original.id === rootId)
  const previous = history.originals[index - 1]
  const next = history.originals[index + 1]
  if ((previous && candidate.mileage < previous.effective.mileage)
    || (next && candidate.mileage > next.effective.mileage)) {
    throw new MileageDomainError("MILEAGE_REGRESSION")
  }
  for (const trip of trips) {
    const { start, end } = resolveTripEntries(history, trip)
    if (!end) continue
    const departureMileage = start.original.id === rootId ? candidate.mileage : start.effective.mileage
    const arrivalMileage = end.original.id === rootId ? candidate.mileage : end.effective.mileage
    if (arrivalMileage < departureMileage) throw new MileageDomainError("MILEAGE_TRIP_INVALID")
  }
  return resolved
}
