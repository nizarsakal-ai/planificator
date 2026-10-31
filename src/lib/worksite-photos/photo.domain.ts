/**
 * Photos d'engins — domaine PUR (SPEC-WORKSITE-PHOTOS-001 §3, §6, §7 ; ADR-PLAN-005).
 * Aucune dépendance Prisma, réseau ou session : états et transitions, bornes de configuration,
 * validation de fichier, nommage Drive, empreinte de requête, preuve d'envoi canonique, schémas Zod,
 * sélections des tâches planifiées. Tout ce qui est testable sans base ni Drive vit ici.
 */
import { createHash } from "node:crypto"
import { z } from "zod"
import { detectMagicMime } from "@/lib/files/magic-mime"
import { businessDay } from "@/lib/time/business-day"

// ─── Erreur de domaine ────────────────────────────────────────────────────────

/** Code stable (SPEC §6.4) + statut HTTP ; le message ne contient jamais de donnée de requête. */
export class WorksitePhotoDomainError extends Error {
  constructor(readonly code: string, readonly status = 409) {
    super(code)
    this.name = "WorksitePhotoDomainError"
  }
}

// ─── États et transitions ─────────────────────────────────────────────────────

export const PHOTO_PHASES = ["BEFORE", "AFTER"] as const
export type PhotoPhase = (typeof PHOTO_PHASES)[number]

/**
 * `PENDING` = non envoyée ; `SENT` = envoi déclaré avec preuve de transport figée ; `DELETED` = envoyée puis mise à la
 * corbeille ; `REJECTED` = rejetée AVANT envoi puis mise à la corbeille (LOT-ADMIN-REVIEW, D20). Terminaux : DELETED, REJECTED.
 */
export const PHOTO_STATUSES = ["PENDING", "SENT", "DELETED", "REJECTED"] as const
export type PhotoStatus = (typeof PHOTO_STATUSES)[number]

const PHOTO_TRANSITIONS: Readonly<Record<PhotoStatus, readonly PhotoStatus[]>> = {
  PENDING: ["SENT", "REJECTED"],
  SENT: ["DELETED"],
  DELETED: [],
  REJECTED: [],
}

export function canTransitionPhoto(from: PhotoStatus, to: PhotoStatus): boolean {
  return from === to || PHOTO_TRANSITIONS[from].includes(to)
}

export const RESERVATION_STATES = ["RESERVED", "UPLOADING", "COMMITTED", "ABANDONED", "CLEANING", "CLOSED"] as const
export type ReservationState = (typeof RESERVATION_STATES)[number]

/** Machine d'états SPEC §3.3 : ABANDONED/CLEANING/CLOSED ne mènent jamais à une publication. */
const RESERVATION_TRANSITIONS: Readonly<Record<ReservationState, readonly ReservationState[]>> = {
  RESERVED: ["UPLOADING", "ABANDONED"],
  UPLOADING: ["COMMITTED", "ABANDONED"],
  COMMITTED: [],
  ABANDONED: ["CLEANING", "CLOSED"],
  CLEANING: ["ABANDONED", "CLOSED"],
  CLOSED: [],
}

export function canTransitionReservation(from: ReservationState, to: ReservationState): boolean {
  return from === to || RESERVATION_TRANSITIONS[from].includes(to)
}

/** États depuis lesquels une publication reste possible (réservation réutilisable par la même clé). */
export function isReservationPublishable(state: ReservationState): boolean {
  return state === "RESERVED" || state === "UPLOADING"
}

/** États non réutilisables : un rejeu de la clé reçoit `UPLOAD_ABORTED` (D18). */
export function isReservationAborted(state: ReservationState): boolean {
  return state === "ABANDONED" || state === "CLEANING" || state === "CLOSED"
}

// ─── Configuration bornée (SPEC §8) ───────────────────────────────────────────

const MIB = 1024 * 1024
/** Plafond dur : corps multipart complet sous la limite Vercel de 4,5 Mo (4 Mio + 64 Kio de marge). */
export const HARD_PHOTO_MAX_BYTES = 4 * MIB
export const DEFAULT_PHOTO_MAX_BYTES = 3 * MIB
/** Marge d'en-têtes multipart au-delà du fichier (patron V3). */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024
/** Taille maximale du champ `payload` JSON. */
export const PAYLOAD_MAX_BYTES = 32 * 1024

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = /^\d+$/.test(raw ?? "") ? Number(raw) : NaN
  if (!Number.isSafeInteger(value) || value < min) return fallback
  return Math.min(value, max)
}

export function getPhotoMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  return boundedInteger(env.WORKSITE_PHOTOS_MAX_BYTES, DEFAULT_PHOTO_MAX_BYTES, 1, HARD_PHOTO_MAX_BYTES)
}

/** Bail d'une tentative d'upload, minutes, borné [5, 60]. */
export function getReservationTtlMinutes(env: NodeJS.ProcessEnv = process.env): number {
  return boundedInteger(env.WORKSITE_PHOTOS_RESERVATION_TTL_MINUTES, 15, 5, 60)
}

/** Durée des contrôles horaires d'une réservation abandonnée, heures, borné [1, 72] ; ne clôt jamais. */
export function getAbandonQuietHours(env: NodeJS.ProcessEnv = process.env): number {
  return boundedInteger(env.WORKSITE_PHOTOS_ABANDON_QUIET_HOURS, 24, 1, 72)
}

/** Seuil d'alerte « non envoyée », jours, borné [1, 365]. */
export function getUnsentAlertDays(env: NodeJS.ProcessEnv = process.env): number {
  return boundedInteger(env.WORKSITE_PHOTOS_UNSENT_ALERT_DAYS, 7, 1, 365)
}

/** Délai corbeille → purge définitive, jours, borné [1, 30] (Google vide la corbeille à 30 jours). */
export function getPurgeAfterDays(env: NodeJS.ProcessEnv = process.env): number {
  return boundedInteger(env.WORKSITE_PHOTOS_PURGE_AFTER_DAYS, 30, 1, 30)
}

// ─── Fichier (SPEC §7.1 étape 3) ──────────────────────────────────────────────

const ALLOWED_EXTENSIONS: Readonly<Record<"image/jpeg" | "image/png", readonly string[]>> = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
}

export interface PhotoFileInput {
  filename: string
  declaredMimeType: string
  bytes: Uint8Array
  /** SHA-256 hexadécimal calculé côté client ; comparé s'il est fourni. */
  clientSha256?: string | null
}

export interface ValidatedPhotoFile {
  filename: string
  mimeType: "image/jpeg" | "image/png"
  sizeBytes: number
  sha256: string
  extension: string
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".")
  return dot <= 0 || dot === filename.length - 1 ? "" : filename.slice(dot).toLowerCase()
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

const SHA256_HEX = /^[0-9a-f]{64}$/

export function validatePhotoFile(input: PhotoFileInput, maxBytes = DEFAULT_PHOTO_MAX_BYTES): ValidatedPhotoFile {
  const rawName = input.filename.replace(/[\\/]+/g, "/").split("/").pop()?.trim() ?? ""
  const filename = rawName.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255)
  if (!filename) throw new WorksitePhotoDomainError("PHOTO_FILENAME_INVALID", 400)
  if (input.bytes.byteLength <= 0) throw new WorksitePhotoDomainError("PHOTO_FILE_EMPTY", 400)
  if (input.bytes.byteLength > Math.min(maxBytes, HARD_PHOTO_MAX_BYTES)) throw new WorksitePhotoDomainError("PHOTO_FILE_TOO_LARGE", 413)
  const magic = detectMagicMime(input.bytes)
  if (magic !== "image/jpeg" && magic !== "image/png") throw new WorksitePhotoDomainError("PHOTO_TYPE_NOT_ALLOWED", 415)
  const extension = extensionOf(filename)
  if (!ALLOWED_EXTENSIONS[magic].includes(extension)) throw new WorksitePhotoDomainError("PHOTO_TYPE_MISMATCH", 415)
  const declared = input.declaredMimeType.toLowerCase().split(";")[0].trim()
  if (declared && declared !== "application/octet-stream" && declared !== magic) throw new WorksitePhotoDomainError("PHOTO_TYPE_MISMATCH", 415)
  const sha256 = sha256Hex(input.bytes)
  if (input.clientSha256 != null) {
    const client = input.clientSha256.trim().toLowerCase()
    // Forme invalide = entrée invalide (même code que le schéma amont) ; seule une empreinte bien formée différente est un écart de somme.
    if (!SHA256_HEX.test(client)) throw new WorksitePhotoDomainError("INVALID_PAYLOAD", 400)
    if (client !== sha256) throw new WorksitePhotoDomainError("PHOTO_CHECKSUM_MISMATCH", 400)
  }
  return { filename, mimeType: magic, sizeBytes: input.bytes.byteLength, sha256, extension }
}

// ─── Nommage Drive (SPEC §7.1 étape 8, D5) ────────────────────────────────────

export const DRIVE_ROOT_FOLDER_NAME = "Chantiers"
const DRIVE_LABEL_MAX = 80
const FORBIDDEN_LABEL_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g

/** Libellé Drive : caractères interdits retirés, espaces compactés, 80 caractères max, jamais vide. */
export function normalizeDriveLabel(value: string, fallback = "sans-nom"): string {
  const cleaned = value.replace(FORBIDDEN_LABEL_CHARS, " ").replace(/\s+/g, " ").trim().slice(0, DRIVE_LABEL_MAX).trim()
  return cleaned.length > 0 ? cleaned : fallback
}

/** Suffixe d'identité systématique (`~<6 premiers caractères de l'id>`), décoratif : la résolution se fait par identité (§3.6). */
export function worksiteFolderLabel(clientName: string, worksiteName: string, worksiteId: string): string {
  const suffix = `~${worksiteId.replace(/[^A-Za-z0-9]/g, "").slice(0, 6) || "000000"}`
  const body = normalizeDriveLabel(`${normalizeDriveLabel(clientName, "client")}-${normalizeDriveLabel(worksiteName, "chantier")}`)
  return `${body.slice(0, DRIVE_LABEL_MAX - suffix.length).trim()}${suffix}`
}

/** Jour civil `yyyy-MM-dd` dans le fuseau de l'entreprise (CompanySettings.timezone). */
export function civilDayLabel(instant: Date, timeZone: string): string {
  return businessDay(instant, timeZone).toISOString().slice(0, 10)
}

/** Identité DATE d'un jour civil (`yyyy-MM-dd` ⇒ minuit UTC de ce jour) : la clé SQL du dossier du jour suit le libellé, jamais l'instant brut. */
export function civilDayDate(dayLabel: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayLabel)) throw new WorksitePhotoDomainError("SERVER_ERROR", 500)
  return new Date(`${dayLabel}T00:00:00.000Z`)
}

/** Nom de fichier Drive : `<yyyyMMdd-HHmmss>_<matricule>_<AVANT|APRES>_<id8>.<ext>` (heure civile du fuseau). */
export function photoFileName(input: { instant: Date; timeZone: string; matricule: string; phase: PhotoPhase; photoId: string; extension: string }): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: input.timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(input.instant)
  const p: Record<string, string> = {}
  for (const part of parts) if (part.type !== "literal") p[part.type] = part.value
  const stamp = `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`
  const plate = normalizeDriveLabel(input.matricule, "ENGIN").replace(/\s+/g, "").toUpperCase()
  const phase = input.phase === "BEFORE" ? "AVANT" : "APRES"
  const id8 = input.photoId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "00000000"
  const ext = input.extension.replace(/^\./, "").toLowerCase() || "jpg"
  return `${stamp}_${plate}_${phase}_${id8}.${ext}`
}

/** Chemin logique conservé en snapshot sur la photo (`drivePath`). */
export function buildDrivePath(worksiteFolder: string, dayLabel: string, fileName: string): string {
  return `/${DRIVE_ROOT_FOLDER_NAME}/${worksiteFolder}/${dayLabel}/${fileName}`
}

// ─── Empreinte de requête (idempotence, SPEC §7.1 étape 3) ────────────────────

export interface UploadRequestIdentity {
  companyId: string
  actorId: string
  worksiteId: string
  truckId: string
  phase: PhotoPhase
  sha256: string
  sizeBytes: number
}

/** SHA-256 d'une sérialisation canonique (clés triées) : même clé + même empreinte ⇒ rejeu ; empreinte différente ⇒ conflit. */
export function computeUploadRequestHash(identity: UploadRequestIdentity): string {
  const canonical = JSON.stringify({
    actorId: identity.actorId, companyId: identity.companyId, phase: identity.phase,
    sha256: identity.sha256, sizeBytes: identity.sizeBytes, truckId: identity.truckId, worksiteId: identity.worksiteId,
  })
  return createHash("sha256").update(canonical).digest("hex")
}

// ─── Schémas Zod (strict, serveur) ────────────────────────────────────────────

const idSchema = z.string().trim().min(1).max(64)
const isoInstant = z.string().datetime({ offset: true })

/** Corps `payload` de l'upload ; les identifiants du chemin peuvent être répétés et doivent alors coïncider. */
export const uploadPayloadSchema = z.object({
  phase: z.enum(PHOTO_PHASES),
  takenAt: isoInstant.optional(),
  clientSha256: z.string().trim().toLowerCase().regex(SHA256_HEX).optional(),
  worksiteId: idSchema.optional(),
  truckId: idSchema.optional(),
}).strict()
export type UploadPayload = z.infer<typeof uploadPayloadSchema>

export function parseUploadPayload(body: unknown, route: { worksiteId: string; truckId: string }): UploadPayload {
  const parsed = uploadPayloadSchema.safeParse(body)
  if (!parsed.success) throw new WorksitePhotoDomainError("INVALID_PAYLOAD", 400)
  const payload = parsed.data
  if ((payload.worksiteId !== undefined && payload.worksiteId !== route.worksiteId)
      || (payload.truckId !== undefined && payload.truckId !== route.truckId)) {
    throw new WorksitePhotoDomainError("PAYLOAD_MISMATCH", 400)
  }
  return payload
}

const UUID_V4ISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** En-tête `Idempotency-Key` : UUID obligatoire (SPEC §6.1). */
export function parseIdempotencyKey(raw: string | null): string {
  const value = raw?.trim() ?? ""
  if (!UUID_V4ISH.test(value)) throw new WorksitePhotoDomainError("IDEMPOTENCY_KEY_REQUIRED", 400)
  return value.toLowerCase()
}

export const TRANSPORT_KIND_PATTERN = /^(smtp|provider:[a-z0-9-]{1,32})$/

/** Corps strict de `mark-sent` (SPEC §6.2, D17) : preuve déclarée par Hermes, forme vérifiée seulement. */
export const markSentBodySchema = z.object({
  sentTo: z.string().trim().min(3).max(254).email(),
  sentMessageId: z.string().trim().min(1).max(255),
  transportKind: z.string().trim().regex(TRANSPORT_KIND_PATTERN),
  transportRef: z.string().trim().min(1).max(255).optional(),
  sentAt: isoInstant.optional(),
}).strict()
export type MarkSentBody = z.infer<typeof markSentBodySchema>

export function parseMarkSentBody(body: unknown): MarkSentBody {
  const parsed = markSentBodySchema.safeParse(body)
  if (!parsed.success) throw new WorksitePhotoDomainError("SENT_PROOF_REQUIRED", 400)
  return parsed.data
}

export interface SentProof {
  sentTo: string
  sentMessageId: string
  transportKind: string
}

/** Preuve canonique du rejeu : destinataire normalisé, identifiant, type de transport ; `sentAt` et `transportRef` ignorés. */
export function canonicalSentProof(proof: SentProof): string {
  return JSON.stringify([proof.sentTo.trim().toLowerCase(), proof.sentMessageId.trim(), proof.transportKind.trim()])
}

export function sentProofEquals(a: SentProof, b: SentProof): boolean {
  return canonicalSentProof(a) === canonicalSentProof(b)
}

/** `Worksite.clientContact` renseigné par Hermes (D6) : e-mail valide ≤ 254. */
export const clientContactSchema = z.object({ clientContact: z.string().trim().min(3).max(254).email() }).strict()

/** Pagination des listes (ES-001-§13.6) : bornée, 100 maximum. */
export const PAGE_MAX_LIMIT = 100
export function parseLimit(raw: string | null, fallback = 50): number {
  if (raw == null || raw === "") return fallback
  if (!/^\d+$/.test(raw)) throw new WorksitePhotoDomainError("INVALID_PAYLOAD", 400)
  const value = Number(raw)
  if (value < 1) throw new WorksitePhotoDomainError("INVALID_PAYLOAD", 400)
  return Math.min(value, PAGE_MAX_LIMIT)
}

// ─── Sélections des tâches planifiées (SPEC §6.3, §7.4) ──────────────────────

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

export function isLeaseExpired(leaseExpiresAt: Date, now: Date): boolean {
  return leaseExpiresAt.getTime() <= now.getTime()
}

/** Alerte J+N : photo PENDING depuis au moins N jours, jamais alertée. */
export function isUnsentAlertDue(photo: { status: PhotoStatus; uploadedAt: Date; unsentAlertedAt: Date | null }, now: Date, days: number): boolean {
  if (photo.status !== "PENDING" || photo.unsentAlertedAt !== null) return false
  return now.getTime() - photo.uploadedAt.getTime() >= days * DAY_MS
}

/** Purge : photo DELETED en corbeille depuis au moins N jours, jamais purgée. */
export function isPurgeDue(photo: { status: PhotoStatus; trashedAt: Date | null; purgedAt: Date | null }, now: Date, days: number): boolean {
  if (photo.status !== "DELETED" || photo.trashedAt === null || photo.purgedAt !== null) return false
  return now.getTime() - photo.trashedAt.getTime() >= days * DAY_MS
}

export interface AbandonedReservationLike {
  state: ReservationState
  abandonedAt: Date | null
  lastRemoteCheckAt: Date | null
}

/**
 * Surveillance durable (R3-1) : contrôle à chaque passage pendant la période de calme, puis au plus une fois
 * par jour, sans limite de durée. Ne décide jamais d'une clôture.
 */
export function isRemoteCheckDue(reservation: AbandonedReservationLike, now: Date, quietHours: number): boolean {
  if (reservation.state !== "ABANDONED") return false
  if (reservation.lastRemoteCheckAt === null) return true
  // Date d'abandon inconnue (ne devrait pas exister, contrainte SQL) : côté sûr, on garde la cadence horaire.
  const since = reservation.abandonedAt ? now.getTime() - reservation.abandonedAt.getTime() : 0
  const inQuietPeriod = since < quietHours * HOUR_MS
  const sinceLastCheck = now.getTime() - reservation.lastRemoteCheckAt.getTime()
  return inQuietPeriod ? sinceLastCheck >= HOUR_MS : sinceLastCheck >= DAY_MS
}

/** Alerte `UNRESOLVED_ABANDON` : une seule fois, au terme de la période de calme. */
export function isUnresolvedAbandonAlertDue(reservation: AbandonedReservationLike & { unresolvedAlertedAt: Date | null }, now: Date, quietHours: number): boolean {
  if (reservation.state !== "ABANDONED" || reservation.unresolvedAlertedAt !== null || reservation.abandonedAt === null) return false
  return now.getTime() - reservation.abandonedAt.getTime() >= quietHours * HOUR_MS
}

/** Suppression en deux phases : TX1 posée depuis plus de 10 minutes sans confirmation ⇒ reprise par le cron. */
export const TRASH_RECONCILE_AFTER_MS = 10 * 60_000
export function isTrashReconcileDue(photo: { status: PhotoStatus; trashRequestedAt: Date | null; trashedAt: Date | null }, now: Date): boolean {
  if (photo.status !== "SENT" || photo.trashRequestedAt === null || photo.trashedAt !== null) return false
  return now.getTime() - photo.trashRequestedAt.getTime() >= TRASH_RECONCILE_AFTER_MS
}

// ─── Contrôle Super Admin : validation interne et suppression (LOT-ADMIN-REVIEW, D19–D21) ─

/** Champs de revue d'une photo (lecture). Les horodatages sont posés par la base ; `null` = jamais posé. */
export interface ReviewFields {
  status: PhotoStatus
  sentAt: Date | null
  approvedAt: Date | null
  rejectRequestedAt: Date | null
  rejectedAt: Date | null
  trashRequestedAt: Date | null
  trashedAt: Date | null
}

/**
 * Deux dimensions DISTINCTES (exigence produit) :
 * - validation interne : `APPROVED` (validée), `TO_REVIEW` (non envoyée, à valider), `NOT_TRACKED` (photo envoyée ou
 *   supprimée sans validation enregistrée : historique antérieur au contrôle, aucune approbation n'est inventée),
 *   `NOT_APPROVED` (rejetée sans avoir été validée) ;
 * - envoi au client : `SENT` seulement si la photo porte une preuve de transport (statut SENT ou DELETED), sinon `NOT_SENT`.
 * Suppression : `NONE`, `TO_RESUME` (intention posée, corbeille ou finalisation inachevée), `TRASHED` (corbeille confirmée).
 */
export type ApprovalState = "APPROVED" | "TO_REVIEW" | "NOT_TRACKED" | "NOT_APPROVED"
export type DeliveryState = "SENT" | "NOT_SENT"
export type DeletionState = "NONE" | "TO_RESUME" | "TRASHED"

export function approvalStateOf(photo: ReviewFields): ApprovalState {
  if (photo.approvedAt) return "APPROVED"
  if (photo.status === "PENDING") return "TO_REVIEW"
  if (photo.status === "REJECTED") return "NOT_APPROVED"
  return "NOT_TRACKED"
}

export function deliveryStateOf(photo: ReviewFields): DeliveryState {
  return photo.status === "SENT" || photo.status === "DELETED" ? "SENT" : "NOT_SENT"
}

export function deletionStateOf(photo: ReviewFields): DeletionState {
  if (photo.status === "REJECTED" || photo.status === "DELETED") return "TRASHED"
  if ((photo.status === "PENDING" && photo.rejectRequestedAt) || (photo.status === "SENT" && photo.trashRequestedAt)) return "TO_RESUME"
  return "NONE"
}

/** Validation : rejeu si déjà validée ; sinon seulement une photo non envoyée, sans suppression engagée. */
export function decideApproval(photo: ReviewFields): "APPROVE" | "REPLAY" {
  if (photo.approvedAt) return "REPLAY"
  if (photo.status === "REJECTED" || photo.status === "DELETED") throw new WorksitePhotoDomainError("PHOTO_REMOVED", 409)
  if (photo.status !== "PENDING") throw new WorksitePhotoDomainError("PHOTO_NOT_PENDING", 409)
  if (photo.rejectRequestedAt) throw new WorksitePhotoDomainError("PHOTO_DELETION_IN_PROGRESS", 409)
  return "APPROVE"
}

/**
 * Suppression, phase 1 : chemin selon le statut. PENDING ⇒ rejet avant envoi (`rejectRequested*` → REJECTED) ;
 * SENT ⇒ cycle existant après envoi (`trashRequested*` → DELETED, preuve intacte). Une photo envoyée n'est jamais
 * requalifiée REJECTED. `writeIntent` = l'intention n'est pas encore posée ; sinon reprise sans nouvelle écriture.
 */
export type DeletionDecision = { kind: "DONE" } | { kind: "REJECT" | "TRASH"; writeIntent: boolean }
export function decideDeletion(photo: ReviewFields): DeletionDecision {
  if (photo.status === "REJECTED" || photo.status === "DELETED") return { kind: "DONE" }
  if (photo.status === "PENDING") return { kind: "REJECT", writeIntent: photo.rejectRequestedAt === null }
  return { kind: "TRASH", writeIntent: photo.trashRequestedAt === null }
}

/** Suppression, phase 3 (sous verrou, après la corbeille Drive) : finaliser une seule fois, ou constater que c'est fait. */
export function decideDeletionFinalize(photo: ReviewFields): "FINALIZE_REJECT" | "FINALIZE_TRASH" | "ALREADY_DONE" {
  if (photo.status === "REJECTED" || photo.status === "DELETED") return "ALREADY_DONE"
  if (photo.status === "PENDING" && photo.rejectRequestedAt) return "FINALIZE_REJECT"
  if (photo.status === "SENT" && photo.trashRequestedAt) return "FINALIZE_TRASH"
  // Intention disparue : impossible (figée en SQL) ; refus explicite plutôt qu'une écriture aveugle.
  throw new WorksitePhotoDomainError("PHOTO_DELETION_CONFLICT", 409)
}

export const REVIEW_FILTERS = ["ALL", "TO_REVIEW", "APPROVED", "SENT", "TO_RESUME", "REMOVED"] as const
export type ReviewFilter = (typeof REVIEW_FILTERS)[number]

export function parseReviewFilter(raw: string | null): ReviewFilter {
  if (raw == null || raw === "") return "ALL"
  const value = raw.trim().toUpperCase()
  if (!(REVIEW_FILTERS as readonly string[]).includes(value)) throw new WorksitePhotoDomainError("INVALID_PAYLOAD", 400)
  return value as ReviewFilter
}

/** Curseur opaque de la galerie (keyset `uploadedAt DESC, id DESC`) : stable même si une photo change d'état entre deux pages. */
export interface ReviewCursor { uploadedAt: Date; id: string }

export function encodeReviewCursor(cursor: ReviewCursor): string {
  return Buffer.from(JSON.stringify({ u: cursor.uploadedAt.toISOString(), i: cursor.id })).toString("base64url")
}

export function decodeReviewCursor(raw: string | null): ReviewCursor | null {
  if (raw == null || raw === "") return null
  try {
    if (raw.length > 512) throw new Error("too long")
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { u?: unknown; i?: unknown }
    if (typeof value.u !== "string" || typeof value.i !== "string" || value.i.length === 0 || value.i.length > 64) throw new Error("shape")
    const uploadedAt = new Date(value.u)
    if (Number.isNaN(uploadedAt.getTime())) throw new Error("date")
    return { uploadedAt, id: value.i }
  } catch {
    throw new WorksitePhotoDomainError("INVALID_PAYLOAD", 400)
  }
}

// ─── Journal : filtre anti-fuite (patron v3-audit) ───────────────────────────

const FORBIDDEN_DETAIL = /https?:\/\/|signature|api_secret|token=|refresh_token|access_token/i

/** Retire toute valeur ressemblant à une URL ou à un secret ; les e-mails sont remplacés par leur empreinte. */
export function sanitizeEventDetail(detail: Record<string, string | number | boolean | null>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of Object.entries(detail)) {
    if (typeof value === "string") {
      if (FORBIDDEN_DETAIL.test(value)) continue
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) { out[key] = `sha256:${createHash("sha256").update(value.trim().toLowerCase()).digest("hex").slice(0, 16)}`; continue }
    }
    out[key] = value
  }
  return out
}
