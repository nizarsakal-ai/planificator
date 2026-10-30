/**
 * Photos d'engins — SERVICE (autorité métier) de l'upload et de la consultation (SPEC-WORKSITE-PHOTOS-001 §4, §7.1 ; ADR-PLAN-005).
 *
 * Tenant et acteur viennent de la session serveur uniquement. Flux d'upload :
 *   pré-autorisation sur les paramètres de route (avant lecture du corps) → validation du fichier → RÉSERVATION
 *   (clé d'idempotence, identifiant Drive préalloué, bail) → dossiers → création Drive idempotente → TRANSACTION
 *   (verrous FOR SHARE, relecture des droits, CAS de la réservation, photo PENDING, événement).
 * Toute écriture sur la réservation est un CAS (état + génération) ; une tentative périmée n'écrit ni ne supprime rien.
 * Le chemin de requête ne supprime JAMAIS de fichier Drive (D18) : les orphelins relèvent du cron de réconciliation.
 * Surface base structurelle (`PhotoDb`) pour des tests sans Prisma.
 */
import { createHash, randomUUID } from "node:crypto"
import { DriveProviderError } from "./drive/drive.errors"
import {
  WorksitePhotoDomainError, buildDrivePath, civilDayDate, civilDayLabel, computeUploadRequestHash, getPhotoMaxBytes, getReservationTtlMinutes,
  isLeaseExpired, isReservationAborted, parseIdempotencyKey, parseLimit, parseUploadPayload, photoFileName, sanitizeEventDetail,
  validatePhotoFile, worksiteFolderLabel, type PhotoPhase, type PhotoStatus, type ReservationState, type UploadPayload, type ValidatedPhotoFile,
} from "./photo.domain"
import type { PhotoStoragePort } from "./photo-storage.port"

// ─── Surface base (structurelle) ──────────────────────────────────────────────

export interface ActorRow { id: string; name: string | null; email: string | null; role: string; companyId: string | null; active: boolean }
export interface EmployeeRow { id: string; firstName: string; lastName: string; active: boolean; role: string; ledTeamIds: string[] }
export interface WorksiteRow { id: string; name: string; status: string; companyId: string; clientName: string }
export interface TruckRow { id: string; matricule: string; active: boolean; companyId: string }
export interface ReservationRow {
  id: string; companyId: string; idempotencyKey: string; requestHash: string; worksiteId: string; truckId: string; uploadedById: string
  photoId: string; driveFileId: string; state: ReservationState; attemptGeneration: number; attemptOwner: string; leaseExpiresAt: Date
  driveFileCreatedAt: Date | null; abandonedAt: Date | null
}
export interface PhotoRow {
  id: string; companyId: string; worksiteId: string; truckId: string; phase: PhotoPhase; status: PhotoStatus; driveFileId: string; drivePath: string
  originalFilename: string; mimeType: string; sizeBytes: number; sha256: string; takenAt: Date | null; uploadedAt: Date; uploadedById: string
  uploadedByNameSnapshot: string; sentAt: Date | null; trashedAt: Date | null
}

/** Visibilité des chantiers selon le rôle (D8) : filtres identiques à `/chantiers` (liste pour EMPLOYEE, détail pour TEAM_LEADER). */
export type WorksiteVisibility = { kind: "all" } | { kind: "employee"; employeeId: string } | { kind: "teams"; teamIds: string[] }

export interface WorksiteQuery { companyId: string; visibility: WorksiteVisibility; worksiteId?: string; excludeArchived: boolean; take?: number }

/** Lecture de l'autorité courante d'un acteur (compte, entreprise, fiche employé) ; partagée entre l'admission et la transaction. */
export interface ActorReader {
  findActor(userId: string): Promise<ActorRow | null>
  findCompany(companyId: string): Promise<{ id: string; active: boolean } | null>
  findEmployee(userId: string, companyId: string): Promise<EmployeeRow | null>
}
/** Condition du CAS : état + génération de la tentative ; `driveFileCreatedAt: null` = « seulement s'il n'est pas encore posé ». */
export interface ReservationCasWhere { id: string; companyId: string; state: ReservationState; attemptGeneration: number; driveFileCreatedAt?: null }
export interface PhotoTx extends ActorReader {
  /** Verrous partagés sur le chantier et l'engin ; renvoie leur état courant (null si absents du tenant). */
  lockWorksiteAndTruck(companyId: string, worksiteId: string, truckId: string): Promise<{ worksite: WorksiteRow | null; truck: TruckRow | null }>
  /**
   * Dans la transaction, l'adaptateur verrouille (`FOR SHARE`) les lignes d'identité relues (compte, entreprise, fiche)
   * et les affectations qui ouvrent la visibilité du chantier : une révocation concurrente attend la fin de la publication.
   */
  findWorksites(query: WorksiteQuery): Promise<WorksiteRow[]>
  reservationCas(where: ReservationCasWhere, data: Record<string, unknown>): Promise<number>
  createPhoto(data: Record<string, unknown>): Promise<PhotoRow>
  createEvent(data: Record<string, unknown>): Promise<unknown>
}
export interface PhotoDb extends ActorReader {
  findTimezone(companyId: string): Promise<string | null>
  findWorksites(query: WorksiteQuery): Promise<WorksiteRow[]>
  findTrucks(companyId: string, truckId?: string): Promise<TruckRow[]>
  /** `INSERT … ON CONFLICT DO NOTHING RETURNING` : `null` si la clé existe déjà pour l'entreprise. */
  createReservationIfAbsent(data: Record<string, unknown>): Promise<ReservationRow | null>
  findReservationByKey(companyId: string, idempotencyKey: string): Promise<ReservationRow | null>
  /** CAS hors transaction : nombre de lignes modifiées (0 = tentative périmée ou condition non remplie). */
  reservationCas(where: ReservationCasWhere, data: Record<string, unknown>): Promise<number>
  findPhotos(args: { companyId: string; worksiteIds?: string[]; photoId?: string; cursor?: string | null; take: number }): Promise<PhotoRow[]>
  createEvent(data: Record<string, unknown>): Promise<unknown>
  transaction<T>(fn: (tx: PhotoTx) => Promise<T>): Promise<T>
}

export interface PhotoSession { user?: { id?: string | null; role?: string | null; companyId?: string | null; name?: string | null } | null }

export interface PhotoServiceDeps {
  db: PhotoDb
  storage: PhotoStoragePort
  env?: NodeJS.ProcessEnv
  clock?: () => Date
  newId?: () => string
}

// ─── Contexte d'acteur et droits (§4) ────────────────────────────────────────

const UPLOAD_ROLES = new Set(["EMPLOYEE", "TEAM_LEADER", "ADMIN", "SUPER_ADMIN"])
const ADMIN_ROLES = new Set(["ADMIN", "SUPER_ADMIN"])

export interface ActorContext {
  userId: string
  companyId: string
  role: string
  displayName: string
  employeeId: string | null
  visibility: WorksiteVisibility
  timezone: string
}

type ActorIdentity = { id: string; role: string; companyId: string }

/**
 * Autorité courante d'un acteur : compte actif, entreprise active, rôle effectif (SUPER_ADMIN global ; sinon la fiche employé
 * de l'entreprise fait foi ; sinon le compte lui-même pour les administrateurs historiques) égal au rôle de session, visibilité D8.
 * Appelée à l'admission (hors transaction) ET relue dans la transaction de publication sur le même `reader` verrouillé.
 */
async function resolveActorRows(reader: ActorReader, identity: ActorIdentity): Promise<Omit<ActorContext, "timezone">> {
  const [actor, company] = await Promise.all([reader.findActor(identity.id), reader.findCompany(identity.companyId)])
  if (!actor?.active) throw new WorksitePhotoDomainError("UNAUTHENTICATED", 401)
  if (!company?.active) throw new WorksitePhotoDomainError("FORBIDDEN", 403)
  const employee = await reader.findEmployee(actor.id, identity.companyId)
  const effectiveRole = actor.role === "SUPER_ADMIN" ? "SUPER_ADMIN"
    : employee ? (employee.active ? employee.role : null)
      : actor.companyId === identity.companyId ? actor.role : null
  if (!effectiveRole || effectiveRole !== identity.role || !UPLOAD_ROLES.has(effectiveRole)) throw new WorksitePhotoDomainError("FORBIDDEN", 403)
  if ((effectiveRole === "EMPLOYEE" || effectiveRole === "TEAM_LEADER") && !employee) throw new WorksitePhotoDomainError("FORBIDDEN", 403)
  const visibility: WorksiteVisibility = ADMIN_ROLES.has(effectiveRole) ? { kind: "all" }
    : effectiveRole === "TEAM_LEADER" ? { kind: "teams", teamIds: employee!.ledTeamIds }
      : { kind: "employee", employeeId: employee!.id }
  const displayName = employee ? `${employee.firstName} ${employee.lastName}`.trim() : (actor.name ?? actor.email ?? actor.id)
  return { userId: actor.id, companyId: identity.companyId, role: effectiveRole, displayName, employeeId: employee?.id ?? null, visibility }
}

/** Session ⇒ acteur effectif relu en base (actif, entreprise active, fiche active pour EMPLOYEE/TEAM_LEADER). */
export async function resolveActor(session: PhotoSession | null, deps: PhotoServiceDeps): Promise<ActorContext> {
  const user = session?.user
  if (!user?.id) throw new WorksitePhotoDomainError("UNAUTHENTICATED", 401)
  const companyId = user.companyId?.trim()
  if (!companyId || !UPLOAD_ROLES.has(user.role ?? "")) throw new WorksitePhotoDomainError("FORBIDDEN", 403)
  const [rows, timezone] = await Promise.all([resolveActorRows(deps.db, { id: user.id, role: user.role!, companyId }), deps.db.findTimezone(companyId)])
  return { ...rows, timezone: timezone ?? "Europe/Paris" }
}

export interface UploadTarget { actor: ActorContext; worksite: WorksiteRow; truck: TruckRow }

/** Pré-autorisation AVANT lecture du corps (R3) : chantier visible et non archivé, engin actif, même entreprise. */
export async function authorizeUploadTarget(session: PhotoSession | null, route: { worksiteId: string; truckId: string }, deps: PhotoServiceDeps): Promise<UploadTarget> {
  const actor = await resolveActor(session, deps)
  const [worksite] = await deps.db.findWorksites({ companyId: actor.companyId, visibility: actor.visibility, worksiteId: route.worksiteId, excludeArchived: false, take: 1 })
  if (!worksite) throw new WorksitePhotoDomainError("WORKSITE_NOT_FOUND", 404)
  if (worksite.status === "ARCHIVED") throw new WorksitePhotoDomainError("WORKSITE_ARCHIVED", 409)
  const [truck] = await deps.db.findTrucks(actor.companyId, route.truckId)
  if (!truck) throw new WorksitePhotoDomainError("TRUCK_NOT_FOUND", 404)
  if (!truck.active) throw new WorksitePhotoDomainError("TRUCK_ARCHIVED", 409)
  return { actor, worksite, truck }
}

// ─── Upload (§7.1 étapes 3 à 9) ──────────────────────────────────────────────

export interface UploadReceipt { photoId: string; status: PhotoStatus; drivePath: string; replayed: boolean }
export interface UploadFileInput { filename: string; declaredMimeType: string; bytes: Uint8Array }

function md5Hex(bytes: Uint8Array): string { return createHash("md5").update(bytes).digest("hex") }

async function event(deps: PhotoServiceDeps, data: { companyId: string; photoId?: string | null; worksiteId?: string | null; action: string; actor: ActorContext; outcome: "DONE" | "FAILED" | "GRANTED" | "DENIED"; detail?: Record<string, string | number | boolean | null> }) {
  await deps.db.createEvent({
    companyId: data.companyId, photoId: data.photoId ?? null, worksiteId: data.worksiteId ?? null, action: data.action,
    actorKind: "USER", actorId: data.actor.userId, actorNameSnapshot: data.actor.displayName, outcome: data.outcome,
    detail: data.detail ? sanitizeEventDetail(data.detail) : undefined,
  })
}

export async function uploadPhoto(target: UploadTarget, file: UploadFileInput, rawPayload: unknown, idempotencyKeyHeader: string | null, deps: PhotoServiceDeps): Promise<UploadReceipt> {
  const env = deps.env ?? process.env
  const clock = deps.clock ?? (() => new Date())
  const newId = deps.newId ?? (() => randomUUID())
  const { actor, worksite, truck } = target
  const idempotencyKey = parseIdempotencyKey(idempotencyKeyHeader)
  const payload: UploadPayload = parseUploadPayload(rawPayload, { worksiteId: worksite.id, truckId: truck.id })
  const validated: ValidatedPhotoFile = validatePhotoFile({ ...file, clientSha256: payload.clientSha256 ?? null }, getPhotoMaxBytes(env))
  const requestHash = computeUploadRequestHash({ companyId: actor.companyId, actorId: actor.userId, worksiteId: worksite.id, truckId: truck.id, phase: payload.phase, sha256: validated.sha256, sizeBytes: validated.sizeBytes })
  const scope = { companyId: actor.companyId }

  // Étape 4 — réservation. Le rejeu d'une clé déjà engagée se résout AVANT tout appel au stockage.
  let reservation = await deps.db.findReservationByKey(actor.companyId, idempotencyKey)
  const attemptOwner = newId()
  if (!reservation) {
    const driveFileId = await deps.storage.preallocateFileId(actor.companyId)
    const photoId = newId().replace(/-/g, "").slice(0, 25)
    const now = clock()
    reservation = await deps.db.createReservationIfAbsent({
      ...scope, idempotencyKey, requestHash, worksiteId: worksite.id, truckId: truck.id, uploadedById: actor.userId, photoId, driveFileId,
      state: "RESERVED", attemptGeneration: 1, attemptOwner, leaseExpiresAt: new Date(now.getTime() + getReservationTtlMinutes(env) * 60_000),
    }) ?? await deps.db.findReservationByKey(actor.companyId, idempotencyKey)
    if (!reservation) throw new WorksitePhotoDomainError("SERVER_ERROR", 500)
    if (reservation.attemptOwner === attemptOwner) await event(deps, { ...scope, worksiteId: worksite.id, action: "RESERVED", actor, outcome: "DONE", detail: { truckId: truck.id, phase: payload.phase } })
  }
  if (reservation.requestHash !== requestHash) throw new WorksitePhotoDomainError("IDEMPOTENCY_CONFLICT", 409)
  if (reservation.state === "COMMITTED") {
    const [photo] = await deps.db.findPhotos({ companyId: actor.companyId, photoId: reservation.photoId, take: 1 })
    if (!photo) throw new WorksitePhotoDomainError("SERVER_ERROR", 500)
    return { photoId: photo.id, status: photo.status, drivePath: photo.drivePath, replayed: true }
  }
  if (isReservationAborted(reservation.state)) throw new WorksitePhotoDomainError("UPLOAD_ABORTED", 409)
  let generation = reservation.attemptGeneration
  if (reservation.attemptOwner !== attemptOwner) {
    // Réservation existante (RESERVED ou UPLOADING) détenue par une autre tentative.
    if (!isLeaseExpired(reservation.leaseExpiresAt, clock())) throw new WorksitePhotoDomainError("UPLOAD_IN_PROGRESS", 409)
    const taken = await deps.db.reservationCas(
      { id: reservation.id, companyId: actor.companyId, state: reservation.state, attemptGeneration: reservation.attemptGeneration },
      { attemptGeneration: reservation.attemptGeneration + 1, attemptOwner, leaseExpiresAt: new Date(clock().getTime() + getReservationTtlMinutes(env) * 60_000), state: "UPLOADING" },
    )
    if (taken !== 1) throw new WorksitePhotoDomainError("UPLOAD_IN_PROGRESS", 409)
    generation = reservation.attemptGeneration + 1
  } else if (reservation.state === "RESERVED") {
    // Étape 5 — CAS vers UPLOADING par la tentative détentrice.
    const moved = await deps.db.reservationCas({ id: reservation.id, companyId: actor.companyId, state: "RESERVED", attemptGeneration: generation }, { state: "UPLOADING" })
    if (moved !== 1) throw new WorksitePhotoDomainError("UPLOAD_SUPERSEDED", 409)
  }
  const cas = (state: ReservationState): ReservationCasWhere => ({ id: reservation!.id, companyId: actor.companyId, state, attemptGeneration: generation })

  // Étape 5 — dossiers et création Drive sur l'identifiant préalloué (idempotente).
  const now = clock()
  const worksiteLabel = worksiteFolderLabel(worksite.clientName, worksite.name, worksite.id)
  const dayLabel = civilDayLabel(now, actor.timezone)
  const fileName = photoFileName({ instant: now, timeZone: actor.timezone, matricule: truck.matricule, phase: payload.phase, photoId: reservation.photoId, extension: validated.extension })
  let drivePath: string
  try {
    // Identité du dossier = jour civil de l'entreprise (même jour que le libellé), jamais l'instant brut (jour UTC).
    const folders = await deps.storage.resolveFolders(actor.companyId, { worksiteId: worksite.id, worksiteLabel, day: civilDayDate(dayLabel), dayLabel })
    drivePath = buildDrivePath(folders.worksiteLabel, folders.dayLabel, fileName)
    const created = await deps.storage.createFile(actor.companyId, {
      id: reservation.driveFileId, name: fileName, parentId: folders.dayFolderId, mimeType: validated.mimeType, bytes: file.bytes,
      appProperties: { reservationId: reservation.id, attemptGeneration: String(generation), photoId: reservation.photoId, companyId: actor.companyId, worksiteId: worksite.id, truckId: truck.id, phase: payload.phase },
    })
    if (!created.created) {
      // Déjà créé par une tentative précédente de la même réservation : vérifier que c'est bien notre contenu.
      const existing = await deps.storage.getFile(actor.companyId, reservation.driveFileId)
      const md5 = md5Hex(file.bytes)
      if (!existing || existing.trashed || (existing.size !== null && existing.size !== validated.sizeBytes) || (existing.md5 !== null && existing.md5 !== md5)) {
        // Contenu inattendu sous NOTRE identifiant : aucun nouvel essai ne peut aboutir ⇒ abandon (le cron traite l'orphelin, D18).
        await event(deps, { ...scope, worksiteId: worksite.id, action: "UPLOAD_ABORTED", actor, outcome: "FAILED", detail: { reservationId: reservation.id, generation, reason: "existing_file_mismatch" } })
        throw new WorksitePhotoDomainError("UPLOAD_ABORTED", 409)
      }
    }
    // Horodatage de création posé UNE fois (immuable en SQL) : une reprise après interruption le laisse tel quel (0 ligne = déjà posé).
    await deps.db.reservationCas({ ...cas("UPLOADING"), driveFileCreatedAt: null }, { driveFileCreatedAt: now })
  } catch (error) {
    if (error instanceof DriveProviderError && error.code === "DRIVE_CONFLICT") {
      // 409 Drive non reconnu comme collision d'identifiant, ou objet distant incohérent (L2-R5) : un nouvel essai de la
      // même clé retomberait sur le même conflit ⇒ abandon, nouvelle prise de vue (nouvelle clé) ; l'orphelin éventuel relève du cron (D18).
      await event(deps, { ...scope, worksiteId: worksite.id, action: "UPLOAD_ABORTED", actor, outcome: "FAILED", detail: { reservationId: reservation.id, generation, reason: error.reason ?? "drive_conflict" } })
      await deps.db.reservationCas(cas("UPLOADING"), { state: "ABANDONED", abandonedAt: clock() })
      throw new WorksitePhotoDomainError("UPLOAD_ABORTED", 409)
    }
    if (error instanceof WorksitePhotoDomainError && error.code === "UPLOAD_ABORTED") {
      await deps.db.reservationCas(cas("UPLOADING"), { state: "ABANDONED", abandonedAt: clock() })
    } else {
      // Tentative terminée sur échec AVANT rattachement (stockage, dossiers) : libérer le bail pour qu'un nouvel essai
      // de la même clé reprenne aussitôt (même identifiant Drive ⇒ reprise idempotente, D15) au lieu d'attendre le TTL.
      await deps.db.reservationCas(cas("UPLOADING"), { leaseExpiresAt: clock() }).catch(() => undefined)
    }
    throw error
  }

  // Étape 6 — transaction de rattachement : verrous, RELECTURE DE L'AUTORITÉ ET DE LA VISIBILITÉ DE L'ACTEUR, CAS → COMMITTED, photo PENDING.
  try {
    const photo = await deps.db.transaction(async (tx) => {
      const locked = await tx.lockWorksiteAndTruck(actor.companyId, worksite.id, truck.id)
      if (!locked.worksite) throw new WorksitePhotoDomainError("WORKSITE_NOT_FOUND", 404)
      if (locked.worksite.status === "ARCHIVED") throw new WorksitePhotoDomainError("WORKSITE_ARCHIVED", 409)
      if (!locked.truck) throw new WorksitePhotoDomainError("TRUCK_NOT_FOUND", 404)
      if (!locked.truck.active) throw new WorksitePhotoDomainError("TRUCK_ARCHIVED", 409)
      // Un compte désactivé, une fiche retirée, un rôle changé ou une affectation révoquée depuis l'admission ⇒ refus, aucune photo.
      const current = await resolveActorRows(tx, { id: actor.userId, role: actor.role, companyId: actor.companyId })
      const [stillVisible] = await tx.findWorksites({ companyId: actor.companyId, visibility: current.visibility, worksiteId: worksite.id, excludeArchived: false, take: 1 })
      if (!stillVisible) throw new WorksitePhotoDomainError("WORKSITE_NOT_FOUND", 404)
      const committed = await tx.reservationCas(cas("UPLOADING"), { state: "COMMITTED" })
      if (committed !== 1) throw new WorksitePhotoDomainError("UPLOAD_SUPERSEDED", 409)
      const row = await tx.createPhoto({
        id: reservation!.photoId, companyId: actor.companyId, worksiteId: worksite.id, truckId: truck.id, reservationId: reservation!.id,
        phase: payload.phase, status: "PENDING", driveFileId: reservation!.driveFileId, drivePath, originalFilename: validated.filename,
        mimeType: validated.mimeType, sizeBytes: validated.sizeBytes, sha256: validated.sha256, takenAt: payload.takenAt ? new Date(payload.takenAt) : null,
        uploadedById: current.userId, uploadedByNameSnapshot: current.displayName,
      })
      await tx.createEvent({ companyId: actor.companyId, photoId: row.id, worksiteId: worksite.id, action: "UPLOADED", actorKind: "USER", actorId: current.userId, actorNameSnapshot: current.displayName, outcome: "DONE", detail: sanitizeEventDetail({ truckId: truck.id, phase: payload.phase, sizeBytes: validated.sizeBytes }) })
      return row
    })
    return { photoId: photo.id, status: photo.status, drivePath: photo.drivePath, replayed: false }
  } catch (error) {
    if (error instanceof WorksitePhotoDomainError && error.code === "UPLOAD_SUPERSEDED") {
      await event(deps, { ...scope, worksiteId: worksite.id, action: "UPLOAD_SUPERSEDED", actor, outcome: "FAILED", detail: { reservationId: reservation.id, generation } })
      throw error
    }
    // Étape 7 — échec applicatif après upload : la tentative détentrice abandonne ; AUCUNE suppression Drive ici (D18).
    await deps.db.reservationCas(cas("UPLOADING"), { state: "ABANDONED", abandonedAt: clock() })
    throw error
  }
}

// ─── Lectures (§6.1) ─────────────────────────────────────────────────────────

export async function listUploadContext(session: PhotoSession | null, deps: PhotoServiceDeps) {
  const actor = await resolveActor(session, deps)
  const [worksites, trucks] = await Promise.all([
    deps.db.findWorksites({ companyId: actor.companyId, visibility: actor.visibility, excludeArchived: true, take: 200 }),
    deps.db.findTrucks(actor.companyId),
  ])
  return {
    role: actor.role,
    worksites: worksites.map((w) => ({ id: w.id, name: w.name, clientName: w.clientName, status: w.status })),
    trucks: trucks.filter((t) => t.active).map((t) => ({ id: t.id, matricule: t.matricule })),
  }
}

export async function listPhotos(session: PhotoSession | null, query: { worksiteId: string | null; cursor: string | null; limit: string | null }, deps: PhotoServiceDeps) {
  const actor = await resolveActor(session, deps)
  const take = parseLimit(query.limit)
  // Administrateurs sans filtre : toute l'entreprise, sans énumérer les chantiers. Sinon : chantiers visibles (D8), filtre éventuel inclus.
  let worksiteIds: string[] | undefined
  if (actor.visibility.kind !== "all" || query.worksiteId) {
    const visible = await deps.db.findWorksites({ companyId: actor.companyId, visibility: actor.visibility, worksiteId: query.worksiteId ?? undefined, excludeArchived: false, take: 500 })
    worksiteIds = visible.map((w) => w.id)
    if (worksiteIds.length === 0) return { photos: [], nextCursor: null }
  }
  const rows = await deps.db.findPhotos({ companyId: actor.companyId, worksiteIds, cursor: query.cursor, take: take + 1 })
  const page = rows.slice(0, take)
  return {
    photos: page.map((p) => ({
      id: p.id, worksiteId: p.worksiteId, truckId: p.truckId, phase: p.phase, status: p.status, drivePath: p.drivePath, originalFilename: p.originalFilename,
      sizeBytes: p.sizeBytes, uploadedAt: p.uploadedAt.toISOString(), uploadedByName: p.uploadedByNameSnapshot, sentAt: p.sentAt?.toISOString() ?? null,
    })),
    nextCursor: rows.length > take ? page[page.length - 1].id : null,
  }
}

/** Proxy privé : droits relus, audit AVANT flux, jamais d'URL Drive. */
export async function openPhotoFile(session: PhotoSession | null, photoId: string, deps: PhotoServiceDeps) {
  const actor = await resolveActor(session, deps)
  const [photo] = await deps.db.findPhotos({ companyId: actor.companyId, photoId, take: 1 })
  const visible = photo ? await deps.db.findWorksites({ companyId: actor.companyId, visibility: actor.visibility, worksiteId: photo.worksiteId, excludeArchived: false, take: 1 }) : []
  if (!photo || visible.length === 0 || photo.status === "DELETED") {
    await event(deps, { companyId: actor.companyId, photoId: photo?.id ?? null, action: "ACCESS_DENIED", actor, outcome: "DENIED", detail: { requested: photoId.slice(0, 64) } })
    throw new WorksitePhotoDomainError("PHOTO_NOT_FOUND", 404)
  }
  await event(deps, { companyId: actor.companyId, photoId: photo.id, worksiteId: photo.worksiteId, action: "ACCESS_GRANTED", actor, outcome: "GRANTED" })
  try {
    const download = await deps.storage.download(actor.companyId, photo.driveFileId)
    // Taille annoncée = taille vérifiée à l'upload (md5/taille) : l'en-tête du fournisseur peut décrire un corps encodé (gzip) et faussement tronquer.
    return { stream: download.stream, mimeType: photo.mimeType, filename: photo.originalFilename, contentLength: photo.sizeBytes }
  } catch (error) {
    if (error instanceof DriveProviderError && error.code === "DRIVE_NOT_FOUND") {
      await event(deps, { companyId: actor.companyId, photoId: photo.id, worksiteId: photo.worksiteId, action: "FILE_MISSING", actor, outcome: "FAILED", detail: { code: "PHOTO_FILE_MISSING" } })
      throw new WorksitePhotoDomainError("PHOTO_FILE_MISSING", 404)
    }
    throw error
  }
}
