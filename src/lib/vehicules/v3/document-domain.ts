/**
 * Véhicules V3 Lot 1 — domaine documentaire pur (aucun Prisma, aucune autorisation).
 * Rubriques, validation des commandes, empreintes d'idempotence, contrôle du fichier,
 * statut documentaire calculé et échéances dans le fuseau de l'entreprise.
 */
import { createHash } from "node:crypto"
import { z } from "zod"
import { MAX_MILEAGE, MileageDomainError } from "../mileage-domain"

import { VEHICLE_DOCUMENT_CATEGORIES, VEHICLE_DOCUMENT_CATEGORY_LABELS, VEHICLE_DOCUMENT_STATUS_LABELS, type VehicleDocumentCategoryCode, type VehicleDocumentStatus } from "./document-view-domain"
export { VEHICLE_DOCUMENT_CATEGORIES, VEHICLE_DOCUMENT_CATEGORY_LABELS, VEHICLE_DOCUMENT_STATUS_LABELS, type VehicleDocumentCategoryCode, type VehicleDocumentStatus } from "./document-view-domain"

// ─── Fichiers ────────────────────────────────────────────────────────────────

export const DEFAULT_DOCUMENT_MAX_BYTES = 4 * 1024 * 1024

export const HARD_DOCUMENT_MAX_BYTES = 4 * 1024 * 1024
export function getVehicleDocumentMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.VEHICLE_DOCUMENT_MAX_BYTES ?? ""
  const raw = /^\d+$/.test(value) ? Number(value) : NaN
  return Number.isSafeInteger(raw) && raw > 0 ? Math.min(raw, HARD_DOCUMENT_MAX_BYTES) : DEFAULT_DOCUMENT_MAX_BYTES
}

const ALLOWED: Record<string, readonly string[]> = {
  "application/pdf": [".pdf"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".")
  return dot <= 0 || dot === filename.length - 1 ? "" : filename.slice(dot).toLowerCase()
}

export function detectMagicMime(buffer: Uint8Array): "application/pdf" | "image/jpeg" | "image/png" | null {
  if (buffer.length < 8) return null
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return "application/pdf"
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg"
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png"
  return null
}

/** Heuristique de refus de marqueurs actifs visibles ; ce contrôle ne constitue pas un assainissement PDF. Le proxy reste sandboxé. */
export function pdfHasActiveContent(buffer: Uint8Array): boolean {
  const head = Buffer.from(buffer.subarray(0, Math.min(buffer.length, 4 * 1024 * 1024))).toString("latin1")
  return /\/(JavaScript|JS|OpenAction|AA|Launch|EmbeddedFile|RichMedia)\b/.test(head)
}

export interface ValidatedDocumentFile {
  filename: string
  mimeType: string
  sizeBytes: number
  sha256: string
  extension: string
}

/**
 * Nom, taille, type déclaré, extension et signature doivent concorder ; aucune source seule
 * n'est crue. Le nom est nettoyé (pas de chemin, longueur bornée).
 */
export function validateDocumentFile(input: { filename: string; declaredMimeType: string; bytes: Uint8Array }, maxBytes = DEFAULT_DOCUMENT_MAX_BYTES): ValidatedDocumentFile {
  const rawName = input.filename.replace(/[\\/]+/g, "/").split("/").pop()?.trim() ?? ""
  const filename = rawName.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255)
  if (!filename) throw new MileageDomainError("DOCUMENT_FILENAME_INVALID", 400)
  if (input.bytes.byteLength <= 0) throw new MileageDomainError("DOCUMENT_FILE_EMPTY", 400)
  if (input.bytes.byteLength > maxBytes) throw new MileageDomainError("DOCUMENT_FILE_TOO_LARGE", 413)
  const declared = input.declaredMimeType.toLowerCase().split(";")[0].trim()
  const magic = detectMagicMime(input.bytes)
  if (!magic) throw new MileageDomainError("DOCUMENT_TYPE_NOT_ALLOWED", 415)
  const extension = extensionOf(filename)
  if (!ALLOWED[magic].includes(extension)) throw new MileageDomainError("DOCUMENT_TYPE_MISMATCH", 415)
  if (declared && declared !== "application/octet-stream" && declared !== magic) throw new MileageDomainError("DOCUMENT_TYPE_MISMATCH", 415)
  if (magic === "application/pdf" && pdfHasActiveContent(input.bytes)) throw new MileageDomainError("DOCUMENT_ACTIVE_CONTENT", 415)
  return { filename, mimeType: magic, sizeBytes: input.bytes.byteLength, sha256: createHash("sha256").update(input.bytes).digest("hex"), extension }
}

// ─── Commandes ───────────────────────────────────────────────────────────────

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}, "invalid_date")
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional().transform((value) => value || null)
const optionalDate = dateOnly.nullable().optional().transform((value) => value ?? null)
const idSchema = z.string().trim().min(1).max(200)

const metadataFields = {
  issuedOn: optionalDate,
  validFrom: optionalDate,
  validUntil: optionalDate,
  issuerName: optionalText(200),
  referenceNumber: optionalText(100),
  observations: optionalText(2000),
  mileage: z.number().int().min(0).max(MAX_MILEAGE).nullable().optional().transform((value) => value ?? null),
  maintenanceEntryId: idSchema.nullable().optional().transform((value) => value ?? null),
}

const uploadSchema = z.object({
  category: z.enum(VEHICLE_DOCUMENT_CATEGORIES),
  title: z.string().trim().min(1).max(200),
  ...metadataFields,
}).strict()

const replaceSchema = z.object({
  expectedRevision: z.number().int().min(1).max(2_147_483_646),
  title: z.string().trim().min(1).max(200).optional(),
  ...metadataFields,
}).strict()

const verifySchema = z.object({ expectedRevision: z.number().int().min(1).max(2_147_483_646), versionId: idSchema }).strict()
const archiveSchema = z.object({ expectedRevision: z.number().int().min(1).max(2_147_483_646), reason: z.string().trim().min(1).max(2000) }).strict()
const settingsSchema = z.object({
  thresholdsDays: z.array(z.number().int().min(0).max(3650)).min(1).max(6),
  expectedRevision: z.number().int().min(0).max(2_147_483_646),
}).strict()

export type DocumentMetadataInput = z.infer<typeof uploadSchema>
export type DocumentUploadInput = z.infer<typeof uploadSchema>
export type DocumentReplaceInput = z.infer<typeof replaceSchema>
export type DocumentVerifyInput = z.infer<typeof verifySchema>
export type DocumentArchiveInput = z.infer<typeof archiveSchema>
export type ReminderSettingsInput = z.infer<typeof settingsSchema>

function requireKey(key: string | null | undefined): string {
  const parsed = z.string().trim().uuid().safeParse(key)
  if (!parsed.success) throw new MileageDomainError("INVALID_IDEMPOTENCY_KEY", 400)
  return parsed.data.toLowerCase()
}

function checkDates(input: { validFrom: string | null; validUntil: string | null }) {
  if (input.validFrom && input.validUntil && input.validFrom > input.validUntil) throw new MileageDomainError("DOCUMENT_DATES_INVALID", 400)
}

export function parseDocumentUpload(body: unknown, key: string | null | undefined) {
  const parsed = uploadSchema.safeParse(body)
  if (!parsed.success) throw new MileageDomainError("INVALID_PAYLOAD", 400)
  checkDates(parsed.data)
  return { ...parsed.data, idempotencyKey: requireKey(key) }
}

export function parseDocumentReplace(body: unknown, key: string | null | undefined) {
  const parsed = replaceSchema.safeParse(body)
  if (!parsed.success) throw new MileageDomainError("INVALID_PAYLOAD", 400)
  checkDates(parsed.data)
  return { ...parsed.data, idempotencyKey: requireKey(key) }
}

export function parseDocumentVerify(body: unknown) {
  const parsed = verifySchema.safeParse(body)
  if (!parsed.success) throw new MileageDomainError("INVALID_PAYLOAD", 400)
  return parsed.data
}

export function parseDocumentArchive(body: unknown) {
  const parsed = archiveSchema.safeParse(body)
  if (!parsed.success) throw new MileageDomainError("INVALID_PAYLOAD", 400)
  return parsed.data
}

export function parseReminderSettings(body: unknown) {
  const parsed = settingsSchema.safeParse(body)
  if (!parsed.success) throw new MileageDomainError("INVALID_PAYLOAD", 400)
  const thresholdsDays = [...new Set(parsed.data.thresholdsDays)].sort((a, b) => b - a)
  return { ...parsed.data, thresholdsDays }
}

/** Empreinte versionnée : commande + fichier (sha256) + tenant/camion/auteur. La clé reste hors empreinte. */
export function documentRequestHash(kind: "UPLOAD" | "REPLACE", command: Record<string, unknown>, file: { sha256: string; filename: string }, scope: { companyId: string; truckId: string; actorId: string; documentId?: string | null }) {
  const canonical = ["vehicle-documents-v3:1", kind, scope.companyId, scope.truckId, scope.actorId, scope.documentId ?? null,
    file.sha256, file.filename, JSON.stringify(command, Object.keys(command).sort())]
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex")
}

/** Les textes des rubriques pièces d'identité restent facultatifs ; aucune périodicité n'est imposée. */
export function assertMetadataForCategory(category: VehicleDocumentCategoryCode, metadata: { validUntil: string | null; mileage: number | null; maintenanceEntryId: string | null }) {
  if (category !== "REPAIR_MAINTENANCE" && metadata.maintenanceEntryId) throw new MileageDomainError("DOCUMENT_MAINTENANCE_LINK_INVALID", 400)
  if (category === "REGISTRATION" && metadata.validUntil) throw new MileageDomainError("DOCUMENT_EXPIRY_NOT_APPLICABLE", 400)
  void metadata.mileage
}

// ─── Dates civiles dans le fuseau de l'entreprise ────────────────────────────

/** Jour civil (AAAA-MM-JJ) d'un instant dans un fuseau IANA ; repli Europe/Paris si fuseau inconnu. */
export function civilDate(instant: Date, timezone: string): string {
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" })
  } catch {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" })
  }
  const parts = formatter.formatToParts(instant)
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00"
  return `${get("year")}-${get("month")}-${get("day")}`
}

/** Jours civils entre deux dates AAAA-MM-JJ (négatif si `target` est passé). */
export function daysBetween(from: string, target: string): number {
  return Math.round((Date.UTC(Number(target.slice(0, 4)), Number(target.slice(5, 7)) - 1, Number(target.slice(8, 10)))
    - Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)))) / 86_400_000)
}

/** Date SQL (DATE → Date à minuit UTC) vers AAAA-MM-JJ, sans décalage de fuseau. */
export function dateOnlyIso(value: Date | string | null | undefined): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null
}

// ─── Statut ──────────────────────────────────────────────────────────────────

export interface VersionStatusInput {
  verifiedAt: Date | string | null
  validUntil: Date | string | null
  validFrom?: Date | string | null
  supersededAt?: Date | string | null
}

export interface DocumentStatusResult {
  status: VehicleDocumentStatus
  remainingDays: number | null
  validUntil: string | null
}

/**
 * Statut d'un dossier à partir de sa version courante. Le seuil d'alerte est le plus grand
 * seuil configuré. Une version présente mais non validée reste « à vérifier » ; une échéance
 * dépassée prime même sans validation.
 */
export function computeDocumentStatus(input: {
  archivedAt: Date | string | null
  currentVersion: VersionStatusInput | null
  today: string
  thresholdsDays: readonly number[]
}): DocumentStatusResult {
  const validUntil = dateOnlyIso(input.currentVersion?.validUntil)
  const remainingDays = validUntil ? daysBetween(input.today, validUntil) : null
  if (input.archivedAt) return { status: "ARCHIVED", remainingDays, validUntil }
  const version = input.currentVersion
  if (!version) return { status: "MISSING", remainingDays: null, validUntil: null }
  if (remainingDays !== null && remainingDays < 0) return { status: "EXPIRED", remainingDays, validUntil }
  const validFrom = dateOnlyIso(version.validFrom)
  if (validFrom && validFrom > input.today) return { status: "NOT_YET_VALID", remainingDays, validUntil }
  if (!version.verifiedAt) return { status: "TO_VERIFY", remainingDays, validUntil }
  const threshold = Math.max(0, ...input.thresholdsDays)
  if (remainingDays !== null && remainingDays <= threshold) return { status: "EXPIRING", remainingDays, validUntil }
  return { status: "VALID", remainingDays, validUntil }
}

export function versionStatus(version: VersionStatusInput, today: string): Extract<VehicleDocumentStatus, "HISTORICAL" | "TO_VERIFY" | "NOT_YET_VALID" | "VALID" | "EXPIRED"> {
  if (version.supersededAt) return "HISTORICAL"
  const validUntil = dateOnlyIso(version.validUntil)
  if (validUntil && daysBetween(today, validUntil) < 0) return "EXPIRED"
  const validFrom = dateOnlyIso(version.validFrom)
  if (validFrom && validFrom > today) return "NOT_YET_VALID"
  return version.verifiedAt ? "VALID" : "TO_VERIFY"
}

// ─── Rappels ─────────────────────────────────────────────────────────────────

export const EXPIRED_THRESHOLD = -1

export interface ReminderCandidate {
  versionId: string
  documentId: string
  truckId: string
  validUntil: Date | string | null
  verifiedAt: Date | string | null
  validFrom?: Date | string | null
  supersededAt: Date | string | null
  archivedAt: Date | string | null
}

export interface DueReminder {
  versionId: string
  documentId: string
  truckId: string
  thresholdDays: number
  dueOn: string
  remainingDays: number
}

/**
 * Rappels exigibles aujourd'hui : pour chaque version courante avec échéance, un rappel par
 * seuil atteint (le reçu unique version/seuil/destinataire évite tout doublon au rejeu),
 * plus un rappel d'expiration (seuil -1) lorsque l'échéance est dépassée. Un dossier archivé
 * ou une version remplacée ne produit plus de rappel. La validation humaine n'est pas requise
 * pour alerter : une pièce non validée mais datée mérite aussi le rappel.
 */
export function dueReminders(candidates: readonly ReminderCandidate[], today: string, thresholdsDays: readonly number[]): DueReminder[] {
  const due: DueReminder[] = []
  const thresholds = [...new Set(thresholdsDays)].sort((a, b) => b - a)
  for (const candidate of candidates) {
    if (candidate.archivedAt || candidate.supersededAt) continue
    const validFrom = dateOnlyIso(candidate.validFrom)
    if (validFrom && validFrom > today) continue
    const validUntil = dateOnlyIso(candidate.validUntil)
    if (!validUntil) continue
    const remainingDays = daysBetween(today, validUntil)
    const base = { versionId: candidate.versionId, documentId: candidate.documentId, truckId: candidate.truckId, dueOn: validUntil, remainingDays }
    if (remainingDays < 0) { due.push({ ...base, thresholdDays: EXPIRED_THRESHOLD }); continue }
    for (const threshold of thresholds) if (remainingDays <= threshold) due.push({ ...base, thresholdDays: threshold })
  }
  return due
}
