/**
 * Véhicules V3 Lot 1 — service documentaire transactionnel.
 * Tenant et acteur viennent de la session serveur uniquement ; chaque commande relit le droit
 * effectif sous le verrou du camion (partagé avec V1/V2), applique idempotence et révision,
 * puis journalise l'audit dans la même transaction.
 *
 * Publication d'une version : contrôle → téléversement privé → transaction de rattachement.
 * Un échec après téléversement déclenche une compensation best-effort du fichier, sans jamais
 * supprimer un objet rattaché. Le stockage et le proxy n'exposent aucune URL signée.
 */
import { createHash, randomUUID } from "node:crypto"
import { Prisma, type PrismaClient, type VehicleDocument, type VehicleDocumentVersion } from "@prisma/client"
import { MileageDomainError } from "../mileage-domain"
import { requireMileageSession, type MileageSession } from "../mileage-access"
import { normalizeMileageFailure } from "../mileage-service"
import { authorizeCompanyAdminLocked, authorizeVehicleV3, canReadDocumentCategory } from "./v3-access"
import { writeVehicleAudit } from "./v3-audit"
import {
  assertMetadataForCategory, civilDate, computeDocumentStatus, dateOnlyIso, documentRequestHash, dueReminders,
  EXPIRED_THRESHOLD, HARD_DOCUMENT_MAX_BYTES, getVehicleDocumentMaxBytes, parseDocumentArchive, parseDocumentReplace, parseDocumentUpload,
  parseDocumentVerify, parseReminderSettings, validateDocumentFile, versionStatus,
  VEHICLE_DOCUMENT_CATEGORY_LABELS, type DocumentMetadataInput, type ValidatedDocumentFile,
} from "./document-domain"
import type { DocumentStoragePort } from "./document-storage.port"

export interface SignedFetchResult { ok: boolean; status: number; body: ReadableStream<Uint8Array> | null; contentLength: number | null }

export interface DocumentServiceDeps {
  auth: () => Promise<MileageSession | null>
  db: Pick<PrismaClient, "$transaction">
  storage: DocumentStoragePort
  /** Récupération du fichier via le lien signé bref ; injectable pour les tests. */
  fetchSigned?: (url: string) => Promise<SignedFetchResult>
  clock?: () => Date
  env?: NodeJS.ProcessEnv
}

export interface DocumentFileInput { filename: string; declaredMimeType: string; bytes: Uint8Array }

type Tx = Prisma.TransactionClient
const transactionOptions = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 10_000 }
const DEFAULT_THRESHOLDS = [30, 7]
const SIGNED_URL_TTL_MS = 60_000

async function databaseNow(tx: Tx) {
  const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS "now"`
  if (!(rows[0]?.now instanceof Date)) throw new MileageDomainError("SERVER_ERROR", 500)
  return rows[0].now
}

async function companyContext(tx: Tx, companyId: string) {
  const [settings, reminder] = await Promise.all([
    tx.companySettings.findFirst({ where: { companyId }, select: { timezone: true } }),
    tx.vehicleDocumentReminderSetting.findFirst({ where: { companyId } }),
  ])
  return { timezone: settings?.timezone ?? "Europe/Paris", thresholdsDays: reminder?.thresholdsDays ?? DEFAULT_THRESHOLDS, settingsRevision: reminder?.revision ?? 0 }
}

function toDateColumn(value: string | null): Date | null {
  return value ? new Date(`${value}T00:00:00.000Z`) : null
}

function versionDto(version: VehicleDocumentVersion, today: string) {
  return {
    id: version.id, versionNumber: version.versionNumber, status: versionStatus(version, today),
    originalFilename: version.originalFilename, mimeType: version.mimeType, sizeBytes: version.sizeBytes, sha256: version.sha256,
    issuedOn: dateOnlyIso(version.issuedOn), validFrom: dateOnlyIso(version.validFrom), validUntil: dateOnlyIso(version.validUntil),
    issuerName: version.issuerName, referenceNumber: version.referenceNumber, observations: version.observations,
    mileage: version.mileage, maintenanceEntryId: version.maintenanceEntryId,
    uploadedAt: version.uploadedAt.toISOString(), uploadedByName: version.uploadedByNameSnapshot,
    verifiedAt: version.verifiedAt?.toISOString() ?? null, verifiedByName: version.verifiedByNameSnapshot,
    supersededAt: version.supersededAt?.toISOString() ?? null,
  }
}

function documentDto(document: VehicleDocument, current: VehicleDocumentVersion | null, today: string, thresholdsDays: readonly number[]) {
  const status = computeDocumentStatus({ archivedAt: document.archivedAt, currentVersion: current, today, thresholdsDays })
  return {
    id: document.id, category: document.category, categoryLabel: VEHICLE_DOCUMENT_CATEGORY_LABELS[document.category], title: document.title,
    revision: document.revision, status: status.status, remainingDays: status.remainingDays, validUntil: status.validUntil,
    archivedAt: document.archivedAt?.toISOString() ?? null, archiveReason: document.archiveReason,
    createdAt: document.createdAt.toISOString(), createdByName: document.createdByNameSnapshot,
    currentVersion: current ? versionDto(current, today) : null,
  }
}

async function currentVersionsFor(tx: Tx, companyId: string, documents: readonly VehicleDocument[]) {
  const ids = documents.map((document) => document.currentVersionId).filter((id): id is string => !!id)
  const versions = ids.length ? await tx.vehicleDocumentVersion.findMany({ where: { companyId, id: { in: ids } } }) : []
  return new Map(versions.map((version) => [version.id, version]))
}

/** Préautorisation HTTP avant lecture des gros corps ; les commandes relisent encore les droits au commit. */
export async function authorizeDocumentWriteBeforeBody(truckId: string, documentId: string | null, deps: DocumentServiceDeps, options: { requireActiveTruck?: boolean; allowArchivedDocument?: boolean } = {}) {
  const session = requireMileageSession(await deps.auth())
  await deps.db.$transaction(async tx => {
    const { truck } = await authorizeVehicleV3(tx, truckId, session, "DOCUMENT_WRITE")
    if (options.requireActiveTruck !== false && !truck.active) throw new MileageDomainError("TRUCK_ARCHIVED", 409)
    if (documentId) {
      const document = await tx.vehicleDocument.findFirst({ where: { id: documentId, truckId, companyId: session.companyId } })
      if (!document) throw new MileageDomainError("DOCUMENT_NOT_FOUND", 404)
      if (document.archivedAt && !options.allowArchivedDocument) throw new MileageDomainError("DOCUMENT_ARCHIVED", 409)
    }
  }, transactionOptions)
}

export async function authorizeReminderSettingsBeforeBody(deps: DocumentServiceDeps) {
  const session = requireMileageSession(await deps.auth())
  await deps.db.$transaction(tx => authorizeCompanyAdminLocked(tx, session), transactionOptions)
}

export async function listVehicleDocuments(truckId: string, deps: DocumentServiceDeps) {
  const session = requireMileageSession(await deps.auth())
  try {
    return await deps.db.$transaction(async (tx) => {
      const { truck, categories } = await authorizeVehicleV3(tx, truckId, session, "DOCUMENT_LIST")
      const scope = { companyId: session.companyId, truckId }
      const context = await companyContext(tx, session.companyId)
      const today = civilDate(await databaseNow(tx), context.timezone)
      const documents = await tx.vehicleDocument.findMany({ where: { ...scope, category: { in: [...categories] } }, orderBy: [{ category: "asc" }, { createdAt: "desc" }] })
      const current = await currentVersionsFor(tx, session.companyId, documents)
      return {
        truckId, matricule: truck.matricule, truckActive: truck.active, today, timezone: context.timezone, thresholdsDays: context.thresholdsDays,
        visibleCategories: categories.map((category) => ({ code: category, label: VEHICLE_DOCUMENT_CATEGORY_LABELS[category] })),
        documents: documents.map((document) => documentDto(document, document.currentVersionId ? current.get(document.currentVersionId) ?? null : null, today, context.thresholdsDays)),
      }
    }, transactionOptions)
  } catch (error) { return normalizeMileageFailure(error) }
}

export async function readVehicleDocument(truckId: string, documentId: string, deps: DocumentServiceDeps) {
  const session = requireMileageSession(await deps.auth())
  try {
    return await deps.db.$transaction(async (tx) => {
      const { actor } = await authorizeVehicleV3(tx, truckId, session, "DOCUMENT_LIST")
      const scope = { companyId: session.companyId, truckId }
      const document = await tx.vehicleDocument.findFirst({ where: { ...scope, id: documentId } })
      if (!document || !canReadDocumentCategory(actor.role, document.category)) throw new MileageDomainError("DOCUMENT_NOT_FOUND", 404)
      const context = await companyContext(tx, session.companyId)
      const today = civilDate(await databaseNow(tx), context.timezone)
      const versions = await tx.vehicleDocumentVersion.findMany({ where: { ...scope, documentId }, orderBy: { versionNumber: "desc" } })
      const current = versions.find((version) => version.id === document.currentVersionId) ?? null
      return { ...documentDto(document, current, today, context.thresholdsDays), versions: versions.map((version) => versionDto(version, today)) }
    }, transactionOptions)
  } catch (error) { return normalizeMileageFailure(error) }
}

async function assertMaintenanceLink(tx: Tx, scope: { companyId: string; truckId: string }, maintenanceEntryId: string | null) {
  if (!maintenanceEntryId) return
  const entry = await tx.vehicleMaintenanceEntry.findFirst({ where: { ...scope, id: maintenanceEntryId }, select: { id: true } })
  if (!entry) throw new MileageDomainError("DOCUMENT_MAINTENANCE_ENTRY_NOT_FOUND", 404)
}

function metadataColumns(input: DocumentMetadataInput | Omit<DocumentMetadataInput, "category" | "title">) {
  return {
    issuedOn: toDateColumn(input.issuedOn), validFrom: toDateColumn(input.validFrom), validUntil: toDateColumn(input.validUntil),
    issuerName: input.issuerName, referenceNumber: input.referenceNumber, observations: input.observations,
    mileage: input.mileage, maintenanceEntryId: input.maintenanceEntryId,
  }
}

interface PublishPlan {
  kind: "UPLOAD" | "REPLACE"
  documentId: string
  versionId: string
  file: ValidatedDocumentFile
  requestHash: string
  idempotencyKey: string
}

type Receipt = { documentId: string; versionId: string; versionNumber: number; revision: number }

/** Replay strict : même clé et même empreinte → même reçu ; empreinte différente → conflit. */
async function replayFor(tx: Tx, scope: { companyId: string; truckId: string }, plan: Pick<PublishPlan, "idempotencyKey" | "requestHash">): Promise<Receipt | null> {
  const previous = await tx.vehicleDocumentVersion.findFirst({ where: { ...scope, idempotencyKey: plan.idempotencyKey } })
  if (!previous) return null
  if (previous.requestHash !== plan.requestHash) throw new MileageDomainError("IDEMPOTENCY_CONFLICT", 409)
  const document = await tx.vehicleDocument.findFirst({ where: { ...scope, id: previous.documentId } })
  if (!document) throw new MileageDomainError("SERVER_ERROR", 500)
  return { documentId: previous.documentId, versionId: previous.id, versionNumber: previous.versionNumber, revision: document.revision }
}

async function closeReminderNotifications(tx: Tx, companyId: string, versionIds: string[], now: Date) {
  if (!versionIds.length) return
  const receipts = await tx.vehicleDocumentReminder.findMany({ where: { companyId, versionId: { in: versionIds } }, select: { notificationId: true } })
  const notificationIds = receipts.map((receipt) => receipt.notificationId).filter((id): id is string => !!id)
  if (notificationIds.length) await tx.notification.updateMany({ where: { id: { in: notificationIds }, companyId, read: false }, data: { read: true, readAt: now } })
}

async function publish(
  truckId: string, kind: "UPLOAD" | "REPLACE", documentId: string | null, body: unknown, file: DocumentFileInput, key: string | null, deps: DocumentServiceDeps,
): Promise<{ receipt: Receipt; replayed: boolean }> {
  const session = requireMileageSession(await deps.auth())
  const validated = validateDocumentFile(file, getVehicleDocumentMaxBytes(deps.env))
  const upload = kind === "UPLOAD" ? parseDocumentUpload(body, key) : null
  const replace = kind === "REPLACE" ? parseDocumentReplace(body, key) : null
  const command = (upload ?? replace)!
  const { idempotencyKey, ...commandWithoutKey } = command
  const scope = { companyId: session.companyId, truckId }
  const requestHash = documentRequestHash(kind, commandWithoutKey, validated, { ...scope, actorId: session.userId, documentId })
  const plan: PublishPlan = { kind, documentId: documentId ?? randomUUID(), versionId: randomUUID(), file: validated, requestHash, idempotencyKey }

  try {
    // 1. Contrôle préalable sous verrou : droit, camion actif, dossier, idempotence. Aucun octet téléversé si refus.
    const pre = await deps.db.$transaction(async (tx) => {
      const { truck, actor } = await authorizeVehicleV3(tx, truckId, session, "DOCUMENT_WRITE")
      const replayed = await replayFor(tx, scope, plan)
      if (replayed) return { replayed, category: null, actor }
      if (!truck.active) throw new MileageDomainError("TRUCK_ARCHIVED", 409)
      let category = upload?.category ?? null
      if (replace) {
        const document = await tx.vehicleDocument.findFirst({ where: { ...scope, id: plan.documentId } })
        if (!document) throw new MileageDomainError("DOCUMENT_NOT_FOUND", 404)
        if (document.archivedAt) throw new MileageDomainError("DOCUMENT_ARCHIVED", 409)
        if (document.revision !== replace.expectedRevision) throw new MileageDomainError("DOCUMENT_REVISION_CONFLICT", 409)
        category = document.category
      }
      assertMetadataForCategory(category!, command)
      await assertMaintenanceLink(tx, scope, command.maintenanceEntryId)
      return { replayed: null, category, actor }
    }, transactionOptions)
    if (pre.replayed) return { receipt: pre.replayed, replayed: true }

    // 2. Téléversement privé hors transaction, clé opaque déterministe.
    const stored = await deps.storage.store({ ...scope, documentId: plan.documentId, versionId: plan.versionId, sha256: validated.sha256, extension: validated.extension }, file.bytes)

    // 3. Rattachement : droits et idempotence relus ; version publiée uniquement ici.
    try {
      const result = await deps.db.$transaction(async (tx) => {
        const { truck, actor } = await authorizeVehicleV3(tx, truckId, session, "DOCUMENT_WRITE")
        const replayed = await replayFor(tx, scope, plan)
        if (replayed) {
          // Compensation réseau seulement après commit, jamais sous les verrous.
          return { receipt: replayed, replayed: true }
        }
        if (!truck.active) throw new MileageDomainError("TRUCK_ARCHIVED", 409)
        const now = await databaseNow(tx)
        const author = { id: actor.id, name: actor.name?.trim() || actor.id }
        let document: VehicleDocument
        let versionNumber = 1
        let supersededVersionId: string | null = null
        if (upload) {
          document = await tx.vehicleDocument.create({ data: {
            id: plan.documentId, ...scope, category: upload.category, title: upload.title, createdById: author.id, createdByNameSnapshot: author.name,
          } })
        } else {
          const existing = await tx.vehicleDocument.findFirst({ where: { ...scope, id: plan.documentId } })
          if (!existing) throw new MileageDomainError("DOCUMENT_NOT_FOUND", 404)
          if (existing.archivedAt) throw new MileageDomainError("DOCUMENT_ARCHIVED", 409)
          if (existing.revision !== replace!.expectedRevision) throw new MileageDomainError("DOCUMENT_REVISION_CONFLICT", 409)
          document = existing
          const latest = await tx.vehicleDocumentVersion.findFirst({ where: { ...scope, documentId: document.id }, orderBy: { versionNumber: "desc" }, select: { versionNumber: true } })
          versionNumber = (latest?.versionNumber ?? 0) + 1
          supersededVersionId = document.currentVersionId
        }
        assertMetadataForCategory(document.category, command)
        await assertMaintenanceLink(tx, scope, command.maintenanceEntryId)
        const version = await tx.vehicleDocumentVersion.create({ data: {
          id: plan.versionId, ...scope, documentId: document.id, versionNumber,
          storageProvider: deps.storage.provider, storageKey: stored.storageKey, storageResourceType: "raw", storageDeliveryType: "authenticated",
          originalFilename: validated.filename, mimeType: validated.mimeType, sizeBytes: validated.sizeBytes, sha256: validated.sha256,
          ...metadataColumns(command), uploadedById: author.id, uploadedByNameSnapshot: author.name, idempotencyKey, requestHash,
        } })
        if (supersededVersionId) {
          const superseded = await tx.vehicleDocumentVersion.updateMany({ where: { ...scope, id: supersededVersionId, supersededAt: null }, data: { supersededAt: now } })
          if (superseded.count !== 1) throw new MileageDomainError("DOCUMENT_REVISION_CONFLICT", 409)
          await closeReminderNotifications(tx, session.companyId, [supersededVersionId], now)
        }
        const nextRevision = upload ? document.revision : document.revision + 1
        const updated = await tx.vehicleDocument.updateMany({
          where: { ...scope, id: document.id, revision: document.revision },
          data: { currentVersionId: version.id, revision: nextRevision, ...(replace?.title ? { title: replace.title } : {}) },
        })
        if (updated.count !== 1) throw new MileageDomainError("DOCUMENT_REVISION_CONFLICT", 409)
        await writeVehicleAudit(tx, {
          companyId: session.companyId, truckId, actorId: author.id, actorNameSnapshot: author.name,
          action: upload ? "DOCUMENT_UPLOAD" : "DOCUMENT_REPLACE", entityType: "VehicleDocumentVersion", entityId: version.id, outcome: "DONE",
          detail: { documentId: document.id, category: document.category, versionNumber, sha256: validated.sha256, sizeBytes: validated.sizeBytes },
        })
        return { receipt: { documentId: document.id, versionId: version.id, versionNumber, revision: nextRevision }, replayed: false }
      }, transactionOptions)
      if (result.replayed) await compensate(deps, stored.storageKey, stored.created)
      return result
    } catch (error) {
      await compensate(deps, stored.storageKey, stored.created)
      throw error
    }
  } catch (error) { return normalizeDocumentFailure(error) }
}

/** Compensation best-effort : seul l'objet créé par cet appel est détruit ; l'échec est journalisé, jamais masqué par une autre erreur. */
async function compensate(deps: DocumentServiceDeps, storageKey: string, created: boolean) {
  if (!created) return
  // Un commit dont l'accusé est perdu peut avoir rattaché l'objet. En cas de doute DB,
  // conserver l'orphelin potentiel pour rapprochement, jamais détruire à l'aveugle.
  try {
    const attached = await deps.db.$transaction(tx => tx.vehicleDocumentVersion.findFirst({ where: { storageKey }, select: { id: true } }), transactionOptions)
    if (attached) return
  } catch { console.error("[vehicle-documents] storage reconciliation required", { storageKey }); return }
  try { await deps.storage.destroy(storageKey) } catch { console.error("[vehicle-documents] orphan file to reconcile", { storageKey }) }
}

export function normalizeDocumentFailure(error: unknown): never {
  if (error instanceof MileageDomainError) throw error
  if (error instanceof Error && error.message === "DOCUMENT_STORAGE_FAILED") throw new MileageDomainError("DOCUMENT_STORAGE_FAILED", 502)
  const e = error as { code?: string; meta?: { code?: string; target?: unknown; constraint?: unknown; database_error?: unknown }; message?: string } | null
  const detail = [e?.meta?.target, e?.meta?.constraint, e?.meta?.database_error, e?.message].map(String).join(" ")
  if ((e?.code === "P2002" || e?.meta?.code === "23505") && /vehicle_document_versions_document_number_key|vehicle_documents_current_version/.test(detail))
    throw new MileageDomainError("DOCUMENT_REVISION_CONFLICT", 409)
  if ((e?.code === "P2002" || e?.meta?.code === "23505") && /vehicle_document_versions_company_truck_idempotency_key/.test(detail))
    throw new MileageDomainError("IDEMPOTENCY_CONFLICT", 409)
  return normalizeMileageFailure(error)
}

export function uploadVehicleDocument(truckId: string, body: unknown, file: DocumentFileInput, key: string | null, deps: DocumentServiceDeps) {
  return publish(truckId, "UPLOAD", null, body, file, key, deps)
}

export function replaceVehicleDocument(truckId: string, documentId: string, body: unknown, file: DocumentFileInput, key: string | null, deps: DocumentServiceDeps) {
  return publish(truckId, "REPLACE", documentId, body, file, key, deps)
}

/** Validation humaine de la version courante : auteur, date, révision. Rejeu identique toléré. */
export async function verifyVehicleDocumentVersion(truckId: string, documentId: string, body: unknown, deps: DocumentServiceDeps) {
  const session = requireMileageSession(await deps.auth())
  const input = parseDocumentVerify(body)
  try {
    return await deps.db.$transaction(async (tx) => {
      const { actor } = await authorizeVehicleV3(tx, truckId, session, "DOCUMENT_VERIFY")
      const scope = { companyId: session.companyId, truckId }
      const document = await tx.vehicleDocument.findFirst({ where: { ...scope, id: documentId } })
      if (!document) throw new MileageDomainError("DOCUMENT_NOT_FOUND", 404)
      const version = await tx.vehicleDocumentVersion.findFirst({ where: { ...scope, documentId, id: input.versionId } })
      if (!version) throw new MileageDomainError("DOCUMENT_VERSION_NOT_FOUND", 404)
      if (document.archivedAt) throw new MileageDomainError("DOCUMENT_ARCHIVED", 409)
      if (document.currentVersionId !== version.id || version.supersededAt) throw new MileageDomainError("DOCUMENT_VERSION_NOT_CURRENT", 409)
      if (version.verifiedAt && version.verifiedById === actor.id && input.expectedRevision === document.revision - 1)
        return { documentId, versionId: version.id, revision: document.revision, replayed: true }
      if (document.revision !== input.expectedRevision) throw new MileageDomainError("DOCUMENT_REVISION_CONFLICT", 409)
      if (version.verifiedAt) throw new MileageDomainError("DOCUMENT_ALREADY_VERIFIED", 409)
      const now = await databaseNow(tx)
      const name = actor.name?.trim() || actor.id
      const verified = await tx.vehicleDocumentVersion.updateMany({ where: { ...scope, id: version.id, verifiedAt: null }, data: { verifiedAt: now, verifiedById: actor.id, verifiedByNameSnapshot: name } })
      if (verified.count !== 1) throw new MileageDomainError("DOCUMENT_ALREADY_VERIFIED", 409)
      const updated = await tx.vehicleDocument.updateMany({ where: { ...scope, id: documentId, revision: document.revision }, data: { revision: document.revision + 1 } })
      if (updated.count !== 1) throw new MileageDomainError("DOCUMENT_REVISION_CONFLICT", 409)
      await writeVehicleAudit(tx, { companyId: session.companyId, truckId, actorId: actor.id, actorNameSnapshot: name, action: "DOCUMENT_VERIFY", entityType: "VehicleDocumentVersion", entityId: version.id, outcome: "DONE", detail: { documentId } })
      return { documentId, versionId: version.id, revision: document.revision + 1, replayed: false }
    }, transactionOptions)
  } catch (error) { return normalizeDocumentFailure(error) }
}

/** Archivage du dossier (conservation intégrale) ; ferme les alertes de rappel ouvertes. */
export async function archiveVehicleDocument(truckId: string, documentId: string, body: unknown, deps: DocumentServiceDeps) {
  const session = requireMileageSession(await deps.auth())
  const input = parseDocumentArchive(body)
  try {
    return await deps.db.$transaction(async (tx) => {
      const { actor } = await authorizeVehicleV3(tx, truckId, session, "DOCUMENT_ARCHIVE")
      const scope = { companyId: session.companyId, truckId }
      const document = await tx.vehicleDocument.findFirst({ where: { ...scope, id: documentId } })
      if (!document) throw new MileageDomainError("DOCUMENT_NOT_FOUND", 404)
      if (document.archivedAt) {
        if (document.archivedById === actor.id && document.archiveReason === input.reason && input.expectedRevision === document.revision - 1) return { documentId, revision: document.revision, replayed: true }
        throw new MileageDomainError("DOCUMENT_ARCHIVED", 409)
      }
      if (document.revision !== input.expectedRevision) throw new MileageDomainError("DOCUMENT_REVISION_CONFLICT", 409)
      const now = await databaseNow(tx)
      const name = actor.name?.trim() || actor.id
      const updated = await tx.vehicleDocument.updateMany({
        where: { ...scope, id: documentId, revision: document.revision, archivedAt: null },
        data: { archivedAt: now, archivedById: actor.id, archivedByNameSnapshot: name, archiveReason: input.reason, revision: document.revision + 1 },
      })
      if (updated.count !== 1) throw new MileageDomainError("DOCUMENT_REVISION_CONFLICT", 409)
      if (document.currentVersionId) await closeReminderNotifications(tx, session.companyId, [document.currentVersionId], now)
      await writeVehicleAudit(tx, { companyId: session.companyId, truckId, actorId: actor.id, actorNameSnapshot: name, action: "DOCUMENT_ARCHIVE", entityType: "VehicleDocument", entityId: documentId, outcome: "DONE", detail: { reason: input.reason } })
      return { documentId, revision: document.revision + 1, replayed: false }
    }, transactionOptions)
  } catch (error) { return normalizeDocumentFailure(error) }
}

export interface DocumentFileAccess {
  stream: ReadableStream<Uint8Array>
  filename: string
  mimeType: string
  contentLength: number | null
}

export const defaultFetchSigned = async (url: string): Promise<SignedFetchResult> => {
  try {
    const response = await fetch(url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) })
    const encoding = response.headers.get("content-encoding")?.trim().toLowerCase()
    const raw = encoding && encoding !== "identity" ? null : response.headers.get("content-length")
    const length = raw !== null && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null
    return { ok: response.ok, status: response.status, body: response.body, contentLength: length }
  } catch { return { ok: false, status: 0, body: null, contentLength: null } }
}

/** Lecture bornée à la taille immuable enregistrée, puis contrôle SHA avant exposition. */
export async function readVerifiedDocumentBytes(fetched: SignedFetchResult, expected: { sizeBytes: number; sha256: string }, maxBytes: number): Promise<Uint8Array> {
  if (!fetched.ok || !fetched.body || !Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes <= 0 || expected.sizeBytes > maxBytes) throw new MileageDomainError("DOCUMENT_FETCH_FAILED", 502)
  if (fetched.contentLength !== null && fetched.contentLength !== expected.sizeBytes) { await fetched.body.cancel(); throw new MileageDomainError("DOCUMENT_FILE_INTEGRITY", 502) }
  const reader = fetched.body.getReader(), chunks: Uint8Array[] = []
  let size = 0, timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new MileageDomainError("DOCUMENT_FETCH_TIMEOUT", 504)) }, 15_000) })
  try {
    while (true) {
      const next = await Promise.race([reader.read(), timeout])
      if (next.done) break
      size += next.value.byteLength
      if (size > expected.sizeBytes) { await reader.cancel(); throw new MileageDomainError("DOCUMENT_FILE_INTEGRITY", 502) }
      chunks.push(next.value)
    }
    if (size !== expected.sizeBytes) throw new MileageDomainError("DOCUMENT_FILE_INTEGRITY", 502)
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    if (createHash("sha256").update(bytes).digest("hex") !== expected.sha256) throw new MileageDomainError("DOCUMENT_FILE_INTEGRITY", 502)
    return bytes
  } finally { if (timer) clearTimeout(timer); reader.releaseLock() }
}

/** Accès contrôlé avant stockage et à nouveau après la lecture ; aucun lien signé ne sort. */
export async function openVehicleDocumentFile(truckId: string, documentId: string, versionId: string, mode: "VIEW" | "DOWNLOAD", deps: DocumentServiceDeps): Promise<DocumentFileAccess> {
  const session = requireMileageSession(await deps.auth())
  const check = async (recordGrant: boolean) => {
    try {
      const result = await deps.db.$transaction(async tx => {
        const { actor } = await authorizeVehicleV3(tx, truckId, session, "DOCUMENT_READ_FILE")
        const scope = { companyId: session.companyId, truckId }
        const document = await tx.vehicleDocument.findFirst({ where: { ...scope, id: documentId } })
        const version = document ? await tx.vehicleDocumentVersion.findFirst({ where: { ...scope, documentId, id: versionId } }) : null
        const allowed = !!document && !!version && canReadDocumentCategory(actor.role, document.category)
        // Le refus est un résultat committé. Jeter dans cette transaction annulerait l'audit.
        if (!allowed || recordGrant) await writeVehicleAudit(tx, {
          companyId: session.companyId, truckId, actorId: actor.id, actorNameSnapshot: actor.name?.trim() || actor.id,
          action: mode === "DOWNLOAD" ? "DOCUMENT_DOWNLOAD" : "DOCUMENT_VIEW", entityType: "VehicleDocumentVersion", entityId: allowed ? version!.id : null,
          outcome: allowed ? "GRANTED" : "DENIED", detail: { documentId, requestedVersionId: versionId, ...(!allowed ? { reason: "NOT_FOUND_OR_CATEGORY" } : {}) },
        })
        return allowed ? { allowed: true as const, target: { storageKey: version!.storageKey, filename: version!.originalFilename, mimeType: version!.mimeType, sizeBytes: version!.sizeBytes, sha256: version!.sha256 } } : { allowed: false as const }
      }, transactionOptions)
      if (!result.allowed) throw new MileageDomainError("DOCUMENT_NOT_FOUND", 404)
      return result.target
    } catch (error) { return normalizeDocumentFailure(error) }
  }
  const target = await check(true)
  const now = deps.clock?.() ?? new Date()
  let signedUrl: string
  try { signedUrl = await deps.storage.createSignedUrl(target.storageKey, new Date(now.getTime() + SIGNED_URL_TTL_MS)) }
  catch { throw new MileageDomainError("DOCUMENT_SIGN_FAILED", 502) }
  let fetched: SignedFetchResult
  try { fetched = await (deps.fetchSigned ?? defaultFetchSigned)(signedUrl) } catch { throw new MileageDomainError("DOCUMENT_FETCH_FAILED", 502) }
  const bytes = await readVerifiedDocumentBytes(fetched, target, HARD_DOCUMENT_MAX_BYTES)
  const currentTarget = await check(false)
  if (currentTarget.storageKey !== target.storageKey || currentTarget.sha256 !== target.sha256) throw new MileageDomainError("DOCUMENT_FILE_INTEGRITY", 502)
  return { stream: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }), filename: target.filename, mimeType: target.mimeType, contentLength: bytes.byteLength }
}

// ─── Paramètres de rappel ────────────────────────────────────────────────────

export async function readReminderSettings(deps: DocumentServiceDeps) {
  const session = requireMileageSession(await deps.auth())
  try {
    return await deps.db.$transaction(async (tx) => {
      await authorizeCompanyAdminLocked(tx, session)
      const context = await companyContext(tx, session.companyId)
      return { thresholdsDays: context.thresholdsDays, revision: context.settingsRevision, timezone: context.timezone }
    }, transactionOptions)
  } catch (error) { return normalizeDocumentFailure(error) }
}

export async function updateReminderSettings(body: unknown, deps: DocumentServiceDeps) {
  const session = requireMileageSession(await deps.auth())
  const input = parseReminderSettings(body)
  try {
    return await deps.db.$transaction(async (tx) => {
      const { actor } = await authorizeCompanyAdminLocked(tx, session)
      const previous = await tx.vehicleDocumentReminderSetting.findFirst({ where: { companyId: session.companyId } })
      const same = previous && previous.thresholdsDays.length === input.thresholdsDays.length && previous.thresholdsDays.every((value, index) => value === input.thresholdsDays[index])
      if (previous && same && input.expectedRevision === previous.revision - 1) return { thresholdsDays: previous.thresholdsDays, revision: previous.revision }
      if ((previous?.revision ?? 0) !== input.expectedRevision) throw new MileageDomainError("REMINDER_SETTINGS_CONFLICT", 409)
      const data = { thresholdsDays: input.thresholdsDays, revision: input.expectedRevision + 1, updatedById: actor.id, updatedByNameSnapshot: actor.name?.trim() || actor.id }
      let saved
      if (previous) {
        const changed = await tx.vehicleDocumentReminderSetting.updateMany({ where: { id: previous.id, revision: previous.revision }, data })
        if (changed.count !== 1) throw new MileageDomainError("REMINDER_SETTINGS_CONFLICT", 409)
        saved = { ...previous, ...data }
      } else {
        saved = await tx.vehicleDocumentReminderSetting.create({ data: { companyId: session.companyId, ...data } })
      }
      await writeVehicleAudit(tx, { companyId: session.companyId, truckId: null, actorId: actor.id, actorNameSnapshot: data.updatedByNameSnapshot, action: "REMINDER_SETTINGS_UPDATE", entityType: "VehicleDocumentReminderSetting", entityId: saved.id, outcome: "DONE", detail: { thresholdsDays: input.thresholdsDays.join(",") } })
      return { thresholdsDays: saved.thresholdsDays, revision: saved.revision }
    }, transactionOptions)
  } catch (error) {
    const failure = error as { code?: string; meta?: { code?: string } } | null
    if (failure?.code === "P2002" || failure?.meta?.code === "23505") throw new MileageDomainError("REMINDER_SETTINGS_CONFLICT", 409)
    return normalizeDocumentFailure(error)
  }
}

// ─── Rappels internes (tâche planifiée, sans session) ────────────────────────

export interface ReminderRunDeps { db: Pick<PrismaClient, "$transaction">; clock?: () => Date }

export interface ReminderRunSummary { companies: number; created: number; alreadySent: number; candidates: number }

/** Rôle effectif sans repli sur le compte principal lorsqu'un profil présent est inactif. */
export function effectiveReminderRole(identity: { role: string; active: boolean; companyId: string | null }, membership: { role: string; active: boolean } | null, companyId: string): string | null {
  if (!identity.active || membership && !membership.active) return null
  const inContext = identity.companyId === companyId || !!membership
  if (!inContext) return null // SUPER_ADMIN global sans contexte d'entreprise : aucun envoi implicite.
  const role = identity.role === "SUPER_ADMIN" ? "SUPER_ADMIN" : membership ? membership.role : identity.role
  return ["ADMIN", "SUPER_ADMIN"].includes(role) ? role : null
}

async function reminderRecipients(tx: Tx, companyId: string): Promise<string[]> {
  const users = await tx.user.findMany({ where: { active: true, OR: [{ companyId }, { employeeProfiles: { some: { companyId } } }] }, select: { id: true, role: true, active: true, companyId: true, employeeProfiles: { where: { companyId }, select: { role: true, active: true } } } })
  return users.filter(user => effectiveReminderRole(user, user.employeeProfiles[0] ?? null, companyId)).map(user => user.id).sort()
}

/** Relecture sous verrou, dans l'ordre truck → user → company → employee de l'autorité V2. */
async function reminderRecipientLocked(tx: Tx, companyId: string, userId: string) {
  const identities = await tx.$queryRaw<{ id: string; role: string; active: boolean; companyId: string | null }[]>`SELECT "id", "role"::text AS "role", "active", "companyId" FROM "users" WHERE "id" = ${userId} FOR SHARE`
  const companies = await tx.$queryRaw<{ active: boolean }[]>`SELECT "active" FROM "companies" WHERE "id" = ${companyId} FOR SHARE`
  const memberships = await tx.$queryRaw<{ role: string; active: boolean }[]>`SELECT "role"::text AS "role", "active" FROM "employees" WHERE "companyId" = ${companyId} AND "userId" = ${userId} FOR SHARE`
  return !!companies[0]?.active && !!identities[0] && !!effectiveReminderRole(identities[0], memberships[0] ?? null, companyId)
}

/**
 * Parcourt les entreprises ayant des dossiers, calcule les rappels exigibles dans leur fuseau
 * et crée notification + reçu dans une transaction par rappel. Le reçu unique rend le rejeu
 * idempotent : un rappel déjà émis est compté « alreadySent », jamais dupliqué.
 */
export async function runVehicleDocumentReminders(deps: ReminderRunDeps): Promise<ReminderRunSummary> {
  const summary: ReminderRunSummary = { companies: 0, created: 0, alreadySent: 0, candidates: 0 }
  const { now, companies } = await deps.db.$transaction(async (tx) => {
    const now = deps.clock?.() ?? await databaseNow(tx)
    const companies = await tx.vehicleDocument.findMany({ where: { archivedAt: null, currentVersionId: { not: null } }, select: { companyId: true }, distinct: ["companyId"] })
    return { now, companies }
  }, transactionOptions)
  // Keep each planning transaction bounded independently of the number of tenants.
  // Delivery still rechecks the current version, company and recipient under locks.
  const plan: { companyId: string; truckId: string; documentId: string; versionId: string; thresholdDays: number; dueOn: string; remainingDays: number; recipients: string[]; matricule: string; title: string; category: string }[] = []
  for (const { companyId } of companies) {
    summary.companies++
    const work = await deps.db.$transaction(async (tx) => {
      const work: { companyId: string; truckId: string; documentId: string; versionId: string; thresholdDays: number; dueOn: string; remainingDays: number; recipients: string[]; matricule: string; title: string; category: string }[] = []
      const context = await companyContext(tx, companyId)
      const today = civilDate(now, context.timezone)
      const documents = await tx.vehicleDocument.findMany({ where: { companyId, archivedAt: null, currentVersionId: { not: null } } })
      const current = await currentVersionsFor(tx, companyId, documents)
      const candidates = documents.flatMap((document) => {
        const version = document.currentVersionId ? current.get(document.currentVersionId) : null
        return version ? [{ versionId: version.id, documentId: document.id, truckId: document.truckId, validFrom: version.validFrom, validUntil: version.validUntil, verifiedAt: version.verifiedAt, supersededAt: version.supersededAt, archivedAt: document.archivedAt }] : []
      })
      const due = dueReminders(candidates, today, context.thresholdsDays)
      if (!due.length) return work
      const recipients = await reminderRecipients(tx, companyId)
      const trucks = await tx.truck.findMany({ where: { companyId, id: { in: [...new Set(due.map((item) => item.truckId))] } }, select: { id: true, matricule: true } })
      const matricules = new Map(trucks.map((truck) => [truck.id, truck.matricule]))
      const titles = new Map(documents.map((document) => [document.id, document]))
      for (const item of due) {
        summary.candidates++
        const document = titles.get(item.documentId)!
        work.push({ companyId, ...item, recipients, matricule: matricules.get(item.truckId) ?? item.truckId, title: document.title, category: document.category })
      }
      return work
    }, { ...transactionOptions, timeout: 30_000 })
    plan.push(...work)
  }

  for (const item of plan) {
    for (const recipientUserId of item.recipients) {
      try {
        await deps.db.$transaction(async (tx) => {
          // Même verrou exclusif que remplacement/archivage : une ancienne alerte ne peut
          // apparaître après la fermeture transactionnelle des alertes de sa version.
          const trucks = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "trucks" WHERE "id" = ${item.truckId} AND "companyId" = ${item.companyId} FOR UPDATE`
          if (!trucks.length || !await reminderRecipientLocked(tx, item.companyId, recipientUserId)) return
          const truck = await tx.truck.findFirst({ where: { id: item.truckId, companyId: item.companyId, active: true } })
          const document = await tx.vehicleDocument.findFirst({ where: { id: item.documentId, truckId: item.truckId, companyId: item.companyId, archivedAt: null, currentVersionId: item.versionId } })
          const version = document ? await tx.vehicleDocumentVersion.findFirst({ where: { id: item.versionId, documentId: item.documentId, truckId: item.truckId, companyId: item.companyId, supersededAt: null } }) : null
          if (!truck || !document || !version) return
          const context = await companyContext(tx, item.companyId)
          const today = civilDate(deps.clock?.() ?? await databaseNow(tx), context.timezone)
          const due = dueReminders([{ versionId: version.id, documentId: document.id, truckId: truck.id, validFrom: version.validFrom, validUntil: version.validUntil, verifiedAt: version.verifiedAt, supersededAt: version.supersededAt, archivedAt: document.archivedAt }], today, context.thresholdsDays).find(d => d.thresholdDays === item.thresholdDays && d.dueOn === item.dueOn)
          if (!due) return
          const existing = await tx.vehicleDocumentReminder.findFirst({ where: { versionId: item.versionId, thresholdDays: item.thresholdDays, recipientUserId }, select: { id: true } })
          if (existing) { summary.alreadySent++; return }
          const expired = item.thresholdDays === EXPIRED_THRESHOLD
          const label = VEHICLE_DOCUMENT_CATEGORY_LABELS[document.category as keyof typeof VEHICLE_DOCUMENT_CATEGORY_LABELS] ?? document.category
          const notification = await tx.notification.create({ data: {
            userId: recipientUserId, companyId: item.companyId, type: expired ? "VEHICLE_DOCUMENT_EXPIRED" : "VEHICLE_DOCUMENT_EXPIRING",
            title: expired ? `Document expiré — ${truck.matricule}` : `Document bientôt échu — ${truck.matricule}`,
            message: expired
              ? `${label} « ${document.title} » : échéance dépassée depuis le ${formatFr(due.dueOn)}.`
              : `${label} « ${document.title} » : échéance le ${formatFr(due.dueOn)} (dans ${due.remainingDays} jour${due.remainingDays > 1 ? "s" : ""}).`,
            link: `/vehicules/${item.truckId}?onglet=documents`,
            metadata: { truckId: item.truckId, documentId: item.documentId, versionId: item.versionId, thresholdDays: item.thresholdDays },
          } })
          await tx.vehicleDocumentReminder.create({ data: {
            companyId: item.companyId, truckId: item.truckId, documentId: item.documentId, versionId: item.versionId,
            thresholdDays: item.thresholdDays, dueOn: toDateColumn(due.dueOn)!, recipientUserId, notificationId: notification.id,
          } })
          summary.created++
        }, transactionOptions)
      } catch (error) {
        const code = (error as { code?: string; meta?: { code?: string } })?.code ?? (error as { meta?: { code?: string } })?.meta?.code
        if (code === "P2002" || code === "23505") { summary.alreadySent++; continue }
        throw error
      }
    }
  }
  return summary
}

function formatFr(dateOnly: string): string {
  const [year, month, day] = dateOnly.split("-")
  return `${day}/${month}/${year}`
}

export type VehicleDocumentListDto = Awaited<ReturnType<typeof listVehicleDocuments>>
export type VehicleDocumentDetailDto = Awaited<ReturnType<typeof readVehicleDocument>>
