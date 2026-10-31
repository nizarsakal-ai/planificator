/**
 * Photos d'engins — SERVICE du contrôle Super Admin (LOT-ADMIN-REVIEW ; décisions D19 à D21).
 *
 * Autorité : SUPER_ADMIN réel uniquement — rôle de session ET rôle relu en base (compte actif, entreprise active), relu de
 * nouveau sous verrous `FOR SHARE` dans la transaction de validation et dans la transaction d'INTENTION de suppression
 * (phase 1). La finalisation (phase 3) ne relit pas l'autorité : elle conclut une intention déjà autorisée dont la
 * corbeille Drive a eu lieu. Tenant = entreprise de la session ; toute photo hors
 * tenant ⇒ 404 uniforme audité `ACCESS_DENIED`. Aucun autre rôle ne peut valider ni supprimer.
 *
 * Deux dimensions distinctes : la VALIDATION INTERNE (`approvedAt…`, sans effet sur le statut) et l'ENVOI AU CLIENT
 * (`SENT` avec preuve de transport, écrit seulement par l'agent d'envoi, absent de ce lot). Valider n'envoie rien.
 *
 * Suppression en deux phases idempotentes, toujours vers la CORBEILLE Drive (jamais de suppression définitive) :
 *   1. transaction : verrou `FOR UPDATE` sur la photo, intention posée une seule fois et attribuée (PENDING ⇒ `rejectRequested*`,
 *      SENT ⇒ `trashRequested*`), événement unique ; l'intention interdit ensuite la validation et l'envoi (garde SQL) ;
 *   2. hors transaction : `storage.trash` (idempotent ; 404 ⇒ déjà absent, événement `FILE_MISSING`) ;
 *   3. transaction : verrou, RELECTURE de l'état, finalisation une seule fois (PENDING ⇒ REJECTED, SENT ⇒ DELETED avec la
 *      preuve d'envoi intacte), événement unique. Un échec entre 1 et 3 laisse « Suppression à reprendre » : un nouvel appel
 *      reprend à la phase 2 sans réécrire l'intention ni dupliquer l'audit.
 */
import { z } from "zod"
import {
  WorksitePhotoDomainError, approvalStateOf, decideApproval, decideDeletion, decideDeletionFinalize, decodeReviewCursor, deletionStateOf,
  deliveryStateOf, encodeReviewCursor, parseLimit, parseReviewFilter, sanitizeEventDetail,
  type ApprovalState, type DeletionState, type DeliveryState, type PhotoPhase, type ReviewCursor, type ReviewFields, type ReviewFilter,
} from "./photo.domain"
import type { PhotoStoragePort } from "./photo-storage.port"
import { resolveActorRows, type ActorContext, type ActorReader, type PhotoSession } from "./photo.service"

// ─── Surface base (structurelle) ──────────────────────────────────────────────

export interface ReviewPhotoRow extends ReviewFields {
  id: string
  companyId: string
  worksiteId: string
  truckId: string
  phase: PhotoPhase
  driveFileId: string
  uploadedAt: Date
  uploadedByNameSnapshot: string
  approvedByNameSnapshot: string | null
  rejectRequestedByNameSnapshot: string | null
  trashRequestedByNameSnapshot: string | null
  worksiteName: string
  clientName: string
  truckMatricule: string
}

export interface ReviewActorRef { id: string; name: string }

export interface ReviewTx extends ActorReader {
  /** Verrou `FOR UPDATE` sur la photo du tenant, puis lecture ; `null` si absente du tenant. */
  lockPhoto(companyId: string, photoId: string): Promise<ReviewPhotoRow | null>
  approve(companyId: string, photoId: string, by: ReviewActorRef): Promise<void>
  requestReject(companyId: string, photoId: string, by: ReviewActorRef): Promise<void>
  finalizeReject(companyId: string, photoId: string): Promise<void>
  requestTrash(companyId: string, photoId: string, by: ReviewActorRef): Promise<void>
  finalizeTrash(companyId: string, photoId: string): Promise<void>
  createEvent(data: Record<string, unknown>): Promise<unknown>
}

export interface ReviewQuery { companyId: string; worksiteId?: string; filter: ReviewFilter; cursor: ReviewCursor | null; take: number }

export interface ReviewDb extends ActorReader {
  findReviewPhotos(query: ReviewQuery): Promise<ReviewPhotoRow[]>
  createEvent(data: Record<string, unknown>): Promise<unknown>
  reviewTransaction<T>(fn: (tx: ReviewTx) => Promise<T>): Promise<T>
}

export interface ReviewServiceDeps {
  reviewDb: ReviewDb
  storage: Pick<PhotoStoragePort, "trash">
}

// ─── Autorité SUPER_ADMIN ─────────────────────────────────────────────────────

type AdminContext = Omit<ActorContext, "timezone">

async function superAdminRows(reader: ActorReader, identity: { id: string; companyId: string }): Promise<AdminContext> {
  const rows = await resolveActorRows(reader, { id: identity.id, role: "SUPER_ADMIN", companyId: identity.companyId })
  if (rows.role !== "SUPER_ADMIN") throw new WorksitePhotoDomainError("FORBIDDEN", 403)
  return rows
}

/** Session SUPER_ADMIN avec entreprise explicite, confirmée en base (compte actif, rôle global SUPER_ADMIN, entreprise active). */
export async function resolveSuperAdmin(session: PhotoSession | null, deps: ReviewServiceDeps): Promise<AdminContext> {
  const user = session?.user
  if (!user?.id) throw new WorksitePhotoDomainError("UNAUTHENTICATED", 401)
  const companyId = user.companyId?.trim()
  if (!companyId || user.role !== "SUPER_ADMIN") throw new WorksitePhotoDomainError("FORBIDDEN", 403)
  return superAdminRows(deps.reviewDb, { id: user.id, companyId })
}

// ─── Représentation (aucun identifiant ni chemin Drive) ───────────────────────

export interface ReviewItem {
  id: string
  worksite: { id: string; name: string; clientName: string }
  truck: { id: string; matricule: string }
  phase: PhotoPhase
  status: ReviewFields["status"]
  uploadedAt: string
  uploadedByName: string
  approval: { state: ApprovalState; at: string | null; byName: string | null }
  delivery: { state: DeliveryState; sentAt: string | null }
  deletion: { state: DeletionState; path: "REJECT" | "TRASH" | null; requestedAt: string | null; byName: string | null; doneAt: string | null }
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)

export function toReviewItem(row: ReviewPhotoRow): ReviewItem {
  const rejectPath = row.status === "REJECTED" || row.rejectRequestedAt !== null
  const trashPath = !rejectPath && (row.status === "DELETED" || row.trashRequestedAt !== null)
  return {
    id: row.id,
    worksite: { id: row.worksiteId, name: row.worksiteName, clientName: row.clientName },
    truck: { id: row.truckId, matricule: row.truckMatricule },
    phase: row.phase,
    status: row.status,
    uploadedAt: row.uploadedAt.toISOString(),
    uploadedByName: row.uploadedByNameSnapshot,
    approval: { state: approvalStateOf(row), at: iso(row.approvedAt), byName: row.approvedByNameSnapshot },
    delivery: { state: deliveryStateOf(row), sentAt: deliveryStateOf(row) === "SENT" ? iso(row.sentAt) : null },
    deletion: {
      state: deletionStateOf(row),
      path: rejectPath ? "REJECT" : trashPath ? "TRASH" : null,
      requestedAt: rejectPath ? iso(row.rejectRequestedAt) : trashPath ? iso(row.trashRequestedAt) : null,
      byName: rejectPath ? row.rejectRequestedByNameSnapshot : trashPath ? row.trashRequestedByNameSnapshot : null,
      doneAt: rejectPath ? iso(row.rejectedAt) : trashPath ? iso(row.trashedAt) : null,
    },
  }
}

// ─── Journal ──────────────────────────────────────────────────────────────────

function eventData(admin: AdminContext, photo: { id: string; worksiteId: string } | null, action: string, outcome: "DONE" | "FAILED" | "DENIED", detail?: Record<string, string | number | boolean | null>) {
  return {
    companyId: admin.companyId, photoId: photo?.id ?? null, worksiteId: photo?.worksiteId ?? null, action,
    actorKind: "USER", actorId: admin.userId, actorNameSnapshot: admin.displayName, outcome,
    detail: detail ? sanitizeEventDetail(detail) : undefined,
  }
}

const photoIdSchema = z.string().trim().min(1).max(64)

/** Identifiant invalide, photo absente ou d'une autre entreprise : 404 uniforme, audité (sans dévoiler l'existence). */
async function notFound(admin: AdminContext, requested: string, deps: ReviewServiceDeps): Promise<never> {
  await deps.reviewDb.createEvent(eventData(admin, null, "ACCESS_DENIED", "DENIED", { requested: requested.slice(0, 64) }))
  throw new WorksitePhotoDomainError("PHOTO_NOT_FOUND", 404)
}

// ─── Liste paginée (galerie) ──────────────────────────────────────────────────

export const REVIEW_PAGE_DEFAULT = 24

export async function listReviewPhotos(session: PhotoSession | null, query: { worksiteId: string | null; filter: string | null; cursor: string | null; limit: string | null }, deps: ReviewServiceDeps) {
  const admin = await resolveSuperAdmin(session, deps)
  const filter = parseReviewFilter(query.filter)
  const take = parseLimit(query.limit, REVIEW_PAGE_DEFAULT)
  const cursor = decodeReviewCursor(query.cursor)
  let worksiteId: string | undefined
  if (query.worksiteId != null && query.worksiteId !== "") {
    const parsed = photoIdSchema.safeParse(query.worksiteId)
    if (!parsed.success) throw new WorksitePhotoDomainError("INVALID_PAYLOAD", 400)
    worksiteId = parsed.data
  }
  const rows = await deps.reviewDb.findReviewPhotos({ companyId: admin.companyId, worksiteId, filter, cursor, take: take + 1 })
  const page = rows.slice(0, take)
  const last = page[page.length - 1]
  return { photos: page.map(toReviewItem), nextCursor: rows.length > take && last ? encodeReviewCursor({ uploadedAt: last.uploadedAt, id: last.id }) : null }
}

// ─── Validation interne ───────────────────────────────────────────────────────

export interface ReviewMutationResult { photo: ReviewItem; replayed: boolean }

export async function approvePhoto(session: PhotoSession | null, rawPhotoId: string, deps: ReviewServiceDeps): Promise<ReviewMutationResult> {
  const admin = await resolveSuperAdmin(session, deps)
  const parsed = photoIdSchema.safeParse(rawPhotoId)
  if (!parsed.success) return notFound(admin, rawPhotoId, deps)
  const photoId = parsed.data
  const result = await deps.reviewDb.reviewTransaction(async (tx) => {
    // Autorité relue sous verrous AVANT la photo (même ordre que la publication : identité, puis ligne métier).
    const current = await superAdminRows(tx, { id: admin.userId, companyId: admin.companyId })
    const photo = await tx.lockPhoto(admin.companyId, photoId)
    if (!photo) return null
    if (decideApproval(photo) === "REPLAY") return { photo, replayed: true }
    await tx.approve(admin.companyId, photoId, { id: current.userId, name: current.displayName })
    await tx.createEvent(eventData(current, photo, "APPROVED", "DONE"))
    const updated = await tx.lockPhoto(admin.companyId, photoId)
    if (!updated) throw new WorksitePhotoDomainError("SERVER_ERROR", 500)
    return { photo: updated, replayed: false }
  })
  if (!result) return notFound(admin, photoId, deps)
  return { photo: toReviewItem(result.photo), replayed: result.replayed }
}

// ─── Suppression vers la corbeille (deux phases) ──────────────────────────────

export interface TrashResult { photo: ReviewItem; replayed: boolean; resumed: boolean }

export async function trashPhoto(session: PhotoSession | null, rawPhotoId: string, deps: ReviewServiceDeps): Promise<TrashResult> {
  const admin = await resolveSuperAdmin(session, deps)
  const parsed = photoIdSchema.safeParse(rawPhotoId)
  if (!parsed.success) return notFound(admin, rawPhotoId, deps)
  const photoId = parsed.data

  // Phase 1 — intention sous verrou, posée et journalisée une seule fois.
  const intent = await deps.reviewDb.reviewTransaction(async (tx) => {
    const current = await superAdminRows(tx, { id: admin.userId, companyId: admin.companyId })
    const photo = await tx.lockPhoto(admin.companyId, photoId)
    if (!photo) return null
    const decision = decideDeletion(photo)
    if (decision.kind === "DONE") return { done: true as const, photo }
    if (decision.writeIntent) {
      const by = { id: current.userId, name: current.displayName }
      if (decision.kind === "REJECT") await tx.requestReject(admin.companyId, photoId, by)
      else await tx.requestTrash(admin.companyId, photoId, by)
      await tx.createEvent(eventData(current, photo, decision.kind === "REJECT" ? "REJECT_REQUESTED" : "TRASH_REQUESTED", "DONE"))
    }
    return { done: false as const, photo, actor: current, resumed: !decision.writeIntent }
  })
  if (!intent) return notFound(admin, photoId, deps)
  if (intent.done) return { photo: toReviewItem(intent.photo), replayed: true, resumed: false }

  // Phase 2 — corbeille Drive HORS transaction (idempotente). Un échec laisse l'intention : « Suppression à reprendre ».
  const trashed = await deps.storage.trash(admin.companyId, intent.photo.driveFileId)

  // Phase 3 — finalisation sous verrou après relecture : une seule écriture et un seul événement, même en concurrence.
  const final = await deps.reviewDb.reviewTransaction(async (tx) => {
    const photo = await tx.lockPhoto(admin.companyId, photoId)
    if (!photo) throw new WorksitePhotoDomainError("SERVER_ERROR", 500)
    const decision = decideDeletionFinalize(photo)
    if (decision === "ALREADY_DONE") return { photo, replayed: true }
    if (decision === "FINALIZE_REJECT") await tx.finalizeReject(admin.companyId, photoId)
    else await tx.finalizeTrash(admin.companyId, photoId)
    if (trashed.missing) await tx.createEvent(eventData(intent.actor, photo, "FILE_MISSING", "FAILED", { code: "PHOTO_FILE_MISSING" }))
    await tx.createEvent(eventData(intent.actor, photo, decision === "FINALIZE_REJECT" ? "REJECTED" : "TRASHED", "DONE", { fileMissing: trashed.missing }))
    const updated = await tx.lockPhoto(admin.companyId, photoId)
    if (!updated) throw new WorksitePhotoDomainError("SERVER_ERROR", 500)
    return { photo: updated, replayed: false }
  })
  return { photo: toReviewItem(final.photo), replayed: final.replayed, resumed: intent.resumed }
}
