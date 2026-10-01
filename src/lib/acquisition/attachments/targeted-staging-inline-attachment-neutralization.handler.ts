/**
 * Harness temporaire Staging Preview — neutralisation des 6 AcquisitionAttachment historiques
 * créés à tort depuis des images MIME inline (preuve Gmail FULL obtenue séparément).
 * Fail-closed. Cible IMMUABLE en code (manifest exact) ; env serveur doit l'égaler ; body sans cible.
 *
 * Transition unique : DISCOVERED → REJECTED, lastErrorCode = INLINE_MIME_EMBEDDED, lastErrorAt = now.
 * CHECK : lecture seule, aucune écriture, jamais une autorisation pour RUN.
 * RUN   : une transaction — verrou FOR UPDATE + revalidation complète des 6 lignes, un seul
 *         updateMany gardé (count === 6), relecture dans la TX ; toute anomalie → rollback.
 * Aucun appel Gmail / OAuth. Aucun log. Erreurs : codes uniquement.
 */

import { NextResponse } from "next/server"
import { Prisma, type PrismaClient } from "@prisma/client"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"

export const INLINE_NEUTRALIZATION_CHECK_CONFIRMATION =
  "CHECK_TARGETED_STAGING_INLINE_ATTACHMENT_NEUTRALIZATION" as const
export const INLINE_NEUTRALIZATION_RUN_CONFIRMATION =
  "RUN_TARGETED_STAGING_INLINE_ATTACHMENT_NEUTRALIZATION" as const

/** planificator-staging (Preview only). */
export const INLINE_NEUTRALIZATION_ALLOWED_VERCEL_PROJECT_ID = "prj_CRp6XttdXjBjPMjJMSMbsUp6hwVD"

export const INLINE_NEUTRALIZATION_ENABLED_FLAG =
  "TARGETED_STAGING_INLINE_ATTACHMENT_NEUTRALIZATION_ENABLED"
export const INLINE_NEUTRALIZATION_COMPANY_ENV = "TARGETED_STAGING_INLINE_NEUTRALIZATION_COMPANY_ID"
export const INLINE_NEUTRALIZATION_MESSAGE_ENV = "TARGETED_STAGING_INLINE_NEUTRALIZATION_MESSAGE_ID"

export const INLINE_MIME_EMBEDDED_ERROR_CODE = "INLINE_MIME_EMBEDDED" as const

/** Cible immuable. */
export const INLINE_NEUTRALIZATION_TARGET = Object.freeze({
  companyId: "cmpqqqyfy0001f5x2blt5qjkh",
  acquisitionMessageId: "cmtvfubf600ssz05onrvhj597",
})

export type InlineManifestEntry = Readonly<{ id: string; filename: string; sizeBytes: number }>

/** Manifest exact : id ↔ filename ↔ sizeBytes. */
export const INLINE_NEUTRALIZATION_MANIFEST: readonly InlineManifestEntry[] = Object.freeze([
  Object.freeze({ id: "cmtvfubht00stz05odjfui0m4", filename: "image006.png", sizeBytes: 230197 }),
  Object.freeze({ id: "cmtvfubht00suz05oy1qx6x4c", filename: "image007.png", sizeBytes: 5807 }),
  Object.freeze({ id: "cmtvfubht00svz05o808akzbh", filename: "image008.png", sizeBytes: 443998 }),
  Object.freeze({ id: "cmtvfubht00swz05o80u0mer5", filename: "image009.png", sizeBytes: 18891 }),
  Object.freeze({ id: "cmtvfubht00sxz05onuz8ifj6", filename: "image010.png", sizeBytes: 37228 }),
  Object.freeze({ id: "cmtvfubht00syz05otw4sd6ev", filename: "image011.png", sizeBytes: 369084 }),
])

const MANIFEST_IDS: readonly string[] = INLINE_NEUTRALIZATION_MANIFEST.map((e) => e.id)
const EXPECTED_MIME = "image/png"
const EXPECTED_CATEGORY = "PHOTO"

/** Seule clé acceptée dans le body. */
const ALLOWED_BODY_KEYS = new Set(["confirmation"])

/** Clés de ciblage interdites, comparées après normalisation (minuscules, sans « _ » / « - »). */
const FORBIDDEN_TARGET_KEYS = new Set(
  [
    "companyId",
    "messageId",
    "acquisitionMessageId",
    "attachmentId",
    "attachmentIds",
    "id",
    "ids",
    "draftId",
    "filename",
    "status",
    "target",
    "targets",
    "manifest",
  ].map(normalizeKey)
)

/** Ligne lue (hors TX pour CHECK, sous FOR UPDATE pour RUN). */
export type InlineAttachmentRow = {
  id: string
  companyId: string
  acquisitionMessageId: string
  status: string
  category: string
  mimeType: string
  filename: string
  sizeBytes: number
  storagePublicId: string | null
  storageUrl: string | null
  storedAt: Date | null
  sha256: string | null
  downloadClaimedAt: Date | null
  lastErrorCode: string | null
}

/** Ligne complète (relecture post-update : champs devant rester inchangés). */
export type InlineAttachmentFullRow = InlineAttachmentRow & {
  attachmentKey: string
  externalAttachmentId: string | null
  lastErrorAt: Date | null
  downloadRetryCount: number
  downloadNextRetryAt: Date | null
}

export type InlineRowFailureCode =
  | "ROW_MISSING"
  | "ROW_DUPLICATE"
  | "COMPANY_MISMATCH"
  | "MESSAGE_MISMATCH"
  | "STATUS_NOT_DISCOVERED"
  | "CATEGORY_MISMATCH"
  | "MIME_MISMATCH"
  | "FILENAME_MISMATCH"
  | "SIZE_MISMATCH"
  | "STORAGE_PUBLIC_ID_SET"
  | "STORAGE_URL_SET"
  | "STORED_AT_SET"
  | "SHA256_SET"
  | "DOWNLOAD_CLAIMED"

export type InlineRowReport = { index: number; ok: boolean; failedChecks: InlineRowFailureCode[] }

export type InlineEvaluation =
  | { kind: "APPLICABLE"; rows: InlineRowReport[] }
  | { kind: "ALREADY_NEUTRALIZED"; rows: InlineRowReport[] }
  | { kind: "PRECONDITION_FAILED"; rows: InlineRowReport[]; unexpectedRows: number }

export type InlineNeutralizationOutcome =
  | { outcome: "NEUTRALIZED"; updated: 6 }
  | { outcome: "ALREADY_NEUTRALIZED" }
  | { outcome: "PRECONDITION_FAILED"; rows: InlineRowReport[]; unexpectedRows: number }
  | { outcome: "UPDATE_COUNT_MISMATCH" }
  | { outcome: "POST_READ_MISMATCH" }
  | { outcome: "TRANSACTION_FAILED" }

export type InlineNeutralizationSession = {
  user: { id: string; role: string; companyId: string | null }
} | null

export type TargetedInlineNeutralizationHandlerDeps = {
  auth?: () => Promise<InlineNeutralizationSession>
  env?: Record<string, string | undefined>
  /** Message cible : id + companyId exacts. */
  loadMessage?: (input: { companyId: string; messageId: string }) => Promise<{ id: string; companyId: string } | null>
  /** CHECK uniquement — lecture hors TX des lignes du manifest. */
  loadTargetRows?: () => Promise<InlineAttachmentRow[]>
  /** RUN — transaction complète (revalidation indépendante, jamais basée sur un CHECK). */
  runNeutralization?: (now: Date) => Promise<InlineNeutralizationOutcome>
  now?: () => Date
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "")
}

/** Runtime fail-closed : uniquement Preview du projet Staging exact. */
export function isInlineNeutralizationSurfaceAllowed(
  env: Record<string, string | undefined> = process.env
): boolean {
  return (
    env.VERCEL_ENV === "preview" &&
    env.VERCEL_PROJECT_ID === INLINE_NEUTRALIZATION_ALLOWED_VERCEL_PROJECT_ID
  )
}

function identityFailures(row: InlineAttachmentRow, entry: InlineManifestEntry): InlineRowFailureCode[] {
  const failures: InlineRowFailureCode[] = []
  if (row.companyId !== INLINE_NEUTRALIZATION_TARGET.companyId) failures.push("COMPANY_MISMATCH")
  if (row.acquisitionMessageId !== INLINE_NEUTRALIZATION_TARGET.acquisitionMessageId) {
    failures.push("MESSAGE_MISMATCH")
  }
  if (row.category !== EXPECTED_CATEGORY) failures.push("CATEGORY_MISMATCH")
  if (row.mimeType !== EXPECTED_MIME) failures.push("MIME_MISMATCH")
  if (row.filename !== entry.filename) failures.push("FILENAME_MISMATCH")
  if (row.sizeBytes !== entry.sizeBytes) failures.push("SIZE_MISMATCH")
  if (row.storagePublicId !== null) failures.push("STORAGE_PUBLIC_ID_SET")
  if (row.storageUrl !== null) failures.push("STORAGE_URL_SET")
  if (row.storedAt !== null) failures.push("STORED_AT_SET")
  if (row.sha256 !== null) failures.push("SHA256_SET")
  if (row.downloadClaimedAt !== null) failures.push("DOWNLOAD_CLAIMED")
  return failures
}

function isAlreadyNeutralizedRow(row: InlineAttachmentRow): boolean {
  return row.status === "REJECTED" && row.lastErrorCode === INLINE_MIME_EMBEDDED_ERROR_CODE
}

/**
 * Validation PURE partagée par CHECK et RUN. Exactement les 6 IDs du manifest, chacun conforme.
 * APPLICABLE : 6 × DISCOVERED conformes. ALREADY_NEUTRALIZED : 6 × REJECTED + INLINE_MIME_EMBEDDED
 * conformes. Toute autre situation (manquante, doublon, inattendue, mixte) → PRECONDITION_FAILED.
 */
export function evaluateInlineNeutralizationRows(rows: readonly InlineAttachmentRow[]): InlineEvaluation {
  const unexpectedRows = rows.filter((r) => !MANIFEST_IDS.includes(r.id)).length
  let allDiscovered = true
  let allNeutralized = true

  const reports: InlineRowReport[] = INLINE_NEUTRALIZATION_MANIFEST.map((entry, i) => {
    const matches = rows.filter((r) => r.id === entry.id)
    if (matches.length === 0) {
      allDiscovered = false
      allNeutralized = false
      return { index: i + 1, ok: false, failedChecks: ["ROW_MISSING"] }
    }
    if (matches.length > 1) {
      allDiscovered = false
      allNeutralized = false
      return { index: i + 1, ok: false, failedChecks: ["ROW_DUPLICATE"] }
    }
    const row = matches[0]!
    const failures = identityFailures(row, entry)
    if (failures.length > 0) {
      allDiscovered = false
      allNeutralized = false
    }
    if (row.status !== "DISCOVERED") allDiscovered = false
    if (!isAlreadyNeutralizedRow(row)) allNeutralized = false
    const statusFailure: InlineRowFailureCode[] =
      row.status === "DISCOVERED" || isAlreadyNeutralizedRow(row) ? [] : ["STATUS_NOT_DISCOVERED"]
    const all = [...failures, ...statusFailure]
    return { index: i + 1, ok: all.length === 0, failedChecks: all }
  })

  if (unexpectedRows === 0 && allDiscovered) return { kind: "APPLICABLE", rows: reports }
  if (unexpectedRows === 0 && allNeutralized) return { kind: "ALREADY_NEUTRALIZED", rows: reports }

  // État mixte (DISCOVERED + REJECTED) : signaler les lignes non DISCOVERED.
  const mixed = reports.map((r, i) => {
    const row = rows.find((x) => x.id === INLINE_NEUTRALIZATION_MANIFEST[i]!.id)
    if (r.ok && row && row.status !== "DISCOVERED") {
      return { ...r, ok: false, failedChecks: ["STATUS_NOT_DISCOVERED" as const] }
    }
    return r
  })
  return { kind: "PRECONDITION_FAILED", rows: mixed, unexpectedRows }
}

class InlineNeutralizationAbort extends Error {
  constructor(
    readonly reason: "PRECONDITION_FAILED" | "UPDATE_COUNT_MISMATCH" | "POST_READ_MISMATCH",
    readonly evaluation?: Extract<InlineEvaluation, { kind: "PRECONDITION_FAILED" }>
  ) {
    super(reason)
    this.name = "InlineNeutralizationAbort"
  }
}

type TxClient = Prisma.TransactionClient

async function lockTargetRows(tx: TxClient): Promise<InlineAttachmentRow[]> {
  return tx.$queryRaw<InlineAttachmentRow[]>`
    SELECT "id", "companyId", "acquisitionMessageId",
           "status"::text AS "status", "category"::text AS "category",
           "mimeType", "filename", "sizeBytes",
           "storagePublicId", "storageUrl", "storedAt", "sha256",
           "downloadClaimedAt", "lastErrorCode"
    FROM "acquisition_attachments"
    WHERE "id" IN (${Prisma.join([...MANIFEST_IDS])})
    ORDER BY "id"
    FOR UPDATE
  `
}

const FULL_ROW_SELECT = {
  id: true,
  companyId: true,
  acquisitionMessageId: true,
  status: true,
  category: true,
  mimeType: true,
  filename: true,
  sizeBytes: true,
  storagePublicId: true,
  storageUrl: true,
  storedAt: true,
  sha256: true,
  downloadClaimedAt: true,
  lastErrorCode: true,
  lastErrorAt: true,
  attachmentKey: true,
  externalAttachmentId: true,
  downloadRetryCount: true,
  downloadNextRetryAt: true,
} as const

function sameInstant(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b
  return a.getTime() === b.getTime()
}

/** Relecture post-update : transition exacte, aucun autre champ métier modifié. */
function isExpectedPostState(
  after: readonly InlineAttachmentFullRow[],
  before: readonly InlineAttachmentFullRow[],
  now: Date
): boolean {
  if (after.length !== 6 || before.length !== 6) return false
  for (const entry of INLINE_NEUTRALIZATION_MANIFEST) {
    const a = after.filter((r) => r.id === entry.id)
    const b = before.filter((r) => r.id === entry.id)
    if (a.length !== 1 || b.length !== 1) return false
    const x = a[0]!
    const y = b[0]!
    if (x.status !== "REJECTED") return false
    if (x.lastErrorCode !== INLINE_MIME_EMBEDDED_ERROR_CODE) return false
    if (!sameInstant(x.lastErrorAt, now)) return false
    if (
      x.companyId !== y.companyId ||
      x.acquisitionMessageId !== y.acquisitionMessageId ||
      x.category !== y.category ||
      x.mimeType !== y.mimeType ||
      x.filename !== y.filename ||
      x.sizeBytes !== y.sizeBytes ||
      x.attachmentKey !== y.attachmentKey ||
      x.externalAttachmentId !== y.externalAttachmentId ||
      x.storagePublicId !== y.storagePublicId ||
      x.storageUrl !== y.storageUrl ||
      !sameInstant(x.storedAt, y.storedAt) ||
      x.sha256 !== y.sha256 ||
      !sameInstant(x.downloadClaimedAt, y.downloadClaimedAt) ||
      x.downloadRetryCount !== y.downloadRetryCount ||
      !sameInstant(x.downloadNextRetryAt, y.downloadNextRetryAt)
    ) {
      return false
    }
  }
  return true
}

/**
 * RUN — transaction unique. Ne fait JAMAIS confiance à un CHECK antérieur :
 * 1. verrou FOR UPDATE + lecture des 6 lignes ; 2. validation complète ;
 * 3. échec → aucune écriture ; 4. un seul updateMany dont le WHERE répète les invariants ;
 * 5. count === 6 sinon rollback ; 6. relecture dans la TX ; 7. anomalie → rollback.
 */
export async function runInlineNeutralizationTransaction(
  db: PrismaClient,
  now: Date
): Promise<InlineNeutralizationOutcome> {
  try {
    return await db.$transaction(async (tx) => {
      const locked = await lockTargetRows(tx)
      const evaluation = evaluateInlineNeutralizationRows(locked)
      if (evaluation.kind === "ALREADY_NEUTRALIZED") {
        return { outcome: "ALREADY_NEUTRALIZED" as const }
      }
      if (evaluation.kind !== "APPLICABLE") {
        throw new InlineNeutralizationAbort("PRECONDITION_FAILED", evaluation)
      }

      const before = (await tx.acquisitionAttachment.findMany({
        where: { id: { in: [...MANIFEST_IDS] } },
        select: FULL_ROW_SELECT,
      })) as InlineAttachmentFullRow[]

      const result = await tx.acquisitionAttachment.updateMany({
        where: {
          companyId: INLINE_NEUTRALIZATION_TARGET.companyId,
          acquisitionMessageId: INLINE_NEUTRALIZATION_TARGET.acquisitionMessageId,
          status: "DISCOVERED",
          category: EXPECTED_CATEGORY,
          mimeType: EXPECTED_MIME,
          storagePublicId: null,
          storageUrl: null,
          storedAt: null,
          sha256: null,
          downloadClaimedAt: null,
          OR: INLINE_NEUTRALIZATION_MANIFEST.map((e) => ({
            id: e.id,
            filename: e.filename,
            sizeBytes: e.sizeBytes,
          })),
        },
        data: {
          status: "REJECTED",
          lastErrorCode: INLINE_MIME_EMBEDDED_ERROR_CODE,
          lastErrorAt: now,
        },
      })
      if (result.count !== 6) {
        throw new InlineNeutralizationAbort("UPDATE_COUNT_MISMATCH")
      }

      const after = (await tx.acquisitionAttachment.findMany({
        where: { id: { in: [...MANIFEST_IDS] } },
        select: FULL_ROW_SELECT,
      })) as InlineAttachmentFullRow[]
      if (!isExpectedPostState(after, before, now)) {
        throw new InlineNeutralizationAbort("POST_READ_MISMATCH")
      }

      return { outcome: "NEUTRALIZED" as const, updated: 6 as const }
    })
  } catch (err) {
    if (err instanceof InlineNeutralizationAbort) {
      if (err.reason === "PRECONDITION_FAILED" && err.evaluation) {
        return {
          outcome: "PRECONDITION_FAILED",
          rows: err.evaluation.rows,
          unexpectedRows: err.evaluation.unexpectedRows,
        }
      }
      if (err.reason === "UPDATE_COUNT_MISMATCH") return { outcome: "UPDATE_COUNT_MISMATCH" }
      if (err.reason === "POST_READ_MISMATCH") return { outcome: "POST_READ_MISMATCH" }
    }
    // Jamais de message / SQL / stack / cause Prisma.
    return { outcome: "TRANSACTION_FAILED" }
  }
}

async function defaultLoadMessage(input: {
  companyId: string
  messageId: string
}): Promise<{ id: string; companyId: string } | null> {
  return prisma.acquisitionMessage.findFirst({
    where: { id: input.messageId, companyId: input.companyId },
    select: { id: true, companyId: true },
  })
}

async function defaultLoadTargetRows(): Promise<InlineAttachmentRow[]> {
  const rows = await prisma.acquisitionAttachment.findMany({
    where: { id: { in: [...MANIFEST_IDS] } },
    select: {
      id: true,
      companyId: true,
      acquisitionMessageId: true,
      status: true,
      category: true,
      mimeType: true,
      filename: true,
      sizeBytes: true,
      storagePublicId: true,
      storageUrl: true,
      storedAt: true,
      sha256: true,
      downloadClaimedAt: true,
      lastErrorCode: true,
    },
  })
  return rows
}

function defaultRunNeutralization(now: Date): Promise<InlineNeutralizationOutcome> {
  return runInlineNeutralizationTransaction(prisma, now)
}

function respond(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } })
}

function refused(status: number, code: string, message: string, extra?: Record<string, unknown>) {
  return respond(status, { ok: false, code, message, ...extra })
}

const HARNESS = "targeted-staging-inline-attachment-neutralization"

export async function handleTargetedStagingInlineAttachmentNeutralization(
  req: Request,
  deps: TargetedInlineNeutralizationHandlerDeps = {}
): Promise<Response> {
  const env = deps.env ?? process.env

  if (!isInlineNeutralizationSurfaceAllowed(env)) {
    return refused(403, "HARNESS_SURFACE_FORBIDDEN", "Surface non autorisée pour ce harness")
  }
  if (env[INLINE_NEUTRALIZATION_ENABLED_FLAG] !== "true") {
    return refused(403, "HARNESS_DISABLED", "Harness désactivé")
  }

  const authenticate = deps.auth ?? (auth as unknown as () => Promise<InlineNeutralizationSession>)
  let session: InlineNeutralizationSession
  try {
    session = await authenticate()
  } catch {
    return refused(401, "UNAUTHORIZED", "Non authentifié")
  }
  if (!session?.user) {
    return refused(401, "UNAUTHORIZED", "Non authentifié")
  }
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) {
    return refused(403, "FORBIDDEN", "Rôle insuffisant")
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return refused(400, "INVALID_BODY", "JSON invalide")
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return refused(400, "INVALID_BODY", "Objet JSON attendu")
  }
  const keys = Object.keys(body)
  if (keys.some((k) => FORBIDDEN_TARGET_KEYS.has(normalizeKey(k)))) {
    return refused(400, "TARGET_OVERRIDE_FORBIDDEN", "La cible ne peut pas être fournie dans la requête")
  }
  if (keys.some((k) => !ALLOWED_BODY_KEYS.has(k))) {
    return refused(400, "UNKNOWN_FIELD", "Champ non autorisé dans la requête")
  }

  const confirmation = (body as { confirmation?: unknown }).confirmation
  const mode =
    confirmation === INLINE_NEUTRALIZATION_CHECK_CONFIRMATION
      ? "CHECK"
      : confirmation === INLINE_NEUTRALIZATION_RUN_CONFIRMATION
        ? "RUN"
        : null
  if (!mode) {
    return refused(400, "CONFIRMATION_REQUIRED", "Confirmation exacte requise")
  }

  const envCompany = (env[INLINE_NEUTRALIZATION_COMPANY_ENV] ?? "").trim()
  const envMessage = (env[INLINE_NEUTRALIZATION_MESSAGE_ENV] ?? "").trim()
  if (!envCompany || !envMessage) {
    return refused(403, "HARNESS_TARGET_UNSET", "Cible company/message non configurée")
  }
  if (
    envCompany !== INLINE_NEUTRALIZATION_TARGET.companyId ||
    envMessage !== INLINE_NEUTRALIZATION_TARGET.acquisitionMessageId
  ) {
    return refused(403, "HARNESS_TARGET_MISMATCH", "Cible env ≠ cible verrouillée du harness")
  }

  const { companyId, acquisitionMessageId } = INLINE_NEUTRALIZATION_TARGET
  if (!session.user.companyId || session.user.companyId !== companyId) {
    return refused(403, "TENANT_MISMATCH", "companyId session ≠ cible harness")
  }

  const loadMessage = deps.loadMessage ?? defaultLoadMessage
  let message: { id: string; companyId: string } | null
  try {
    message = await loadMessage({ companyId, messageId: acquisitionMessageId })
  } catch {
    return refused(500, "MESSAGE_LOAD_FAILED", "Lecture du message cible impossible")
  }
  if (!message || message.id !== acquisitionMessageId || message.companyId !== companyId) {
    return refused(404, "MESSAGE_NOT_FOUND", "AcquisitionMessage cible introuvable pour ce tenant")
  }

  if (mode === "CHECK") {
    const loadTargetRows = deps.loadTargetRows ?? defaultLoadTargetRows
    let rows: InlineAttachmentRow[]
    try {
      rows = await loadTargetRows()
    } catch {
      return refused(500, "TARGET_ROWS_LOAD_FAILED", "Lecture des pièces cibles impossible")
    }
    const evaluation = evaluateInlineNeutralizationRows(rows)
    return respond(200, {
      ok: true,
      harness: HARNESS,
      mode: "CHECK",
      result: evaluation.kind,
      wouldApply: evaluation.kind === "APPLICABLE",
      rows: evaluation.rows,
      unexpectedRows: evaluation.kind === "PRECONDITION_FAILED" ? evaluation.unexpectedRows : 0,
    })
  }

  // RUN — revalidation complète dans la transaction, indépendante de tout CHECK.
  const runNeutralization = deps.runNeutralization ?? defaultRunNeutralization
  const now = (deps.now ?? (() => new Date()))()
  let outcome: InlineNeutralizationOutcome
  try {
    outcome = await runNeutralization(now)
  } catch {
    outcome = { outcome: "TRANSACTION_FAILED" }
  }

  switch (outcome.outcome) {
    case "NEUTRALIZED":
      return respond(200, { ok: true, harness: HARNESS, mode: "RUN", result: "NEUTRALIZED", updated: 6 })
    case "ALREADY_NEUTRALIZED":
      return refused(409, "ALREADY_NEUTRALIZED", "Les 6 pièces sont déjà neutralisées — aucune écriture")
    case "PRECONDITION_FAILED":
      return refused(409, "PRECONDITION_FAILED", "Préconditions non satisfaites — aucune écriture", {
        rows: outcome.rows,
        unexpectedRows: outcome.unexpectedRows,
      })
    case "UPDATE_COUNT_MISMATCH":
      return refused(409, "UPDATE_COUNT_MISMATCH", "Nombre de lignes modifiées ≠ 6 — rollback")
    case "POST_READ_MISMATCH":
      return refused(409, "POST_READ_MISMATCH", "Relecture post-transition non conforme — rollback")
    default:
      return refused(500, "TRANSACTION_FAILED", "Transaction échouée — rollback")
  }
}
