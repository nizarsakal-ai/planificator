/**
 * Harness temporaire Staging Preview — synchronisation Gmail Acquisition CIBLÉE sur UNE connexion.
 * Fail-closed. Cible via env uniquement (companyId + AcquisitionGmailConnection id).
 *
 * CHECK : lecture de la connexion cible uniquement (existence, tenant, active). Aucun Gmail,
 *         aucun token, aucune sync, aucune écriture.
 * RUN   : UN appel à syncAcquisitionMailForCompany (service normal du cron) pour la connexion
 *         configurée, mailShadow désactivé. Opération WRITE staging réelle : lecture Gmail, refresh
 *         OAuth normal possible, ingestion normale (message / draft / attachments), avance du curseur.
 * INSPECT : lecture seule des AcquisitionMessage GMAIL de la connexion cible reçus depuis
 *         INSPECT_RECEIVED_SINCE (≤ 20, champs minimaux + draft associé). Aucun Gmail, aucune sync.
 * Jamais : cron global, listing des connexions, driver, boucle multi-connexions, retry.
 * Sortie : statut + compteurs + code d'erreur sûr. Aucun token, secret, message Gmail ou message d'erreur brut.
 */

import { NextResponse } from "next/server"
import type { Prisma } from "@prisma/client"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { syncAcquisitionMailForCompany } from "@/lib/acquisition/connector/acquisition-gmail-sync.service"
import { createGmailMailProviderAdapter } from "@/lib/acquisition/connector/gmail-mail-provider.adapter"
import { acquisitionIngestionAdapter } from "@/lib/acquisition/ports/acquisition-ingestion.adapter"
import { acquisitionScanCursorRepository } from "@/lib/acquisition/persistence/acquisition-scan-cursor.repository"
import type { MailSyncResult } from "@/lib/acquisition/connector/connector.types"
import type { MailProviderPort } from "@/lib/acquisition/ports/mail-provider.port"

export const TARGETED_GMAIL_SYNC_CHECK_CONFIRMATION = "CHECK_TARGETED_STAGING_GMAIL_SYNC" as const
export const TARGETED_GMAIL_SYNC_RUN_CONFIRMATION = "RUN_TARGETED_STAGING_GMAIL_SYNC" as const
export const TARGETED_GMAIL_SYNC_INSPECT_CONFIRMATION = "INSPECT_TARGETED_STAGING_GMAIL_SYNC" as const

/** INSPECT : fenêtre de réception et borne de lecture (fixes, non paramétrables par la requête). */
export const INSPECT_RECEIVED_SINCE = "2026-10-01T00:00:00.000Z"
export const INSPECT_MAX_MESSAGES = 20

/** Termes de détection (sujet, insensible à la casse). */
const PENVEN_SUBJECT_TERMS = ["biscuiterie penven", "penven", "pontaven", "pont aven"]

/** planificator-staging (Preview only). */
export const GMAIL_SYNC_ALLOWED_VERCEL_PROJECT_ID = "prj_CRp6XttdXjBjPMjJMSMbsUp6hwVD"

export const GMAIL_SYNC_ENABLED_FLAG = "TARGETED_STAGING_GMAIL_SYNC_ENABLED"
export const GMAIL_SYNC_COMPANY_ENV = "TARGETED_STAGING_GMAIL_SYNC_COMPANY_ID"
export const GMAIL_SYNC_CONNECTION_ENV = "TARGETED_STAGING_GMAIL_SYNC_CONNECTION_ID"

const HARNESS = "targeted-staging-gmail-sync"

/** Seule clé acceptée dans le body. */
const ALLOWED_BODY_KEYS = new Set(["confirmation"])

/** Clés de ciblage interdites, comparées après normalisation (minuscules, sans « _ » / « - »). */
const FORBIDDEN_TARGET_KEYS = new Set(
  [
    "companyId",
    "connectionId",
    "acquisitionGmailConnectionId",
    "gmailConnectionId",
    "mailboxKey",
    "sourceMailboxKey",
    "mailbox",
    "email",
    "emailAddress",
    "address",
    "messageId",
    "externalMessageId",
    "acquisitionMessageId",
    "draftId",
    "target",
  ].map(normalizeKey)
)

/** Format d'un code d'erreur interne exposable (jamais le message). */
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/

export type GmailSyncSession = {
  user: { id: string; role: string; companyId: string | null }
} | null

export type GmailSyncConnectionTarget = { id: string; companyId: string; active: boolean }

export type GmailSyncInvocation = Parameters<typeof syncAcquisitionMailForCompany>[0]

/** Ligne INSPECT : exactement les champs sélectionnés. */
export type GmailSyncInspectRow = {
  id: string
  externalMessageId: string
  sourceMailboxKey: string
  senderEmail: string
  subject: string
  receivedAt: Date
  status: string
  createdAt: Date
  updatedAt: Date
  draft: { id: string; status: string; createdWorksiteId: string | null } | null
}

const INSPECT_SELECT = {
  id: true,
  externalMessageId: true,
  sourceMailboxKey: true,
  senderEmail: true,
  subject: true,
  receivedAt: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  draft: { select: { id: true, status: true, createdWorksiteId: true } },
} satisfies Prisma.AcquisitionMessageSelect

/** Arguments Prisma INSPECT (lecture seule), construits uniquement depuis la cible env. */
export function buildInspectFindManyArgs(input: { companyId: string; connectionId: string }) {
  return {
    where: {
      companyId: input.companyId,
      source: "GMAIL" as const,
      sourceMailboxKey: input.connectionId,
      receivedAt: { gte: new Date(INSPECT_RECEIVED_SINCE) },
    },
    orderBy: { receivedAt: "desc" as const },
    take: INSPECT_MAX_MESSAGES,
    select: INSPECT_SELECT,
  } satisfies Prisma.AcquisitionMessageFindManyArgs
}

export type GmailSyncInspectArgs = ReturnType<typeof buildInspectFindManyArgs>

export function isPenvenCandidateSubject(subject: unknown): boolean {
  if (typeof subject !== "string") return false
  const s = subject.toLowerCase()
  return PENVEN_SUBJECT_TERMS.some((t) => s.includes(t))
}

export type TargetedGmailSyncHandlerDeps = {
  auth?: () => Promise<GmailSyncSession>
  env?: Record<string, string | undefined>
  /** Lecture seule : connexion cible par id + companyId exacts. */
  loadConnection?: (input: { companyId: string; connectionId: string }) => Promise<GmailSyncConnectionTarget | null>
  /** Service normal (défaut : syncAcquisitionMailForCompany). */
  sync?: (input: GmailSyncInvocation) => Promise<MailSyncResult>
  /** Adaptateur Gmail normal (défaut : createGmailMailProviderAdapter). */
  createProvider?: () => MailProviderPort
  ingestion?: GmailSyncInvocation["ingestion"]
  cursorRepository?: GmailSyncInvocation["cursorRepository"]
  /** INSPECT — lecture seule (défaut : prisma.acquisitionMessage.findMany). */
  findMessages?: (args: GmailSyncInspectArgs) => Promise<GmailSyncInspectRow[]>
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "")
}

/** Runtime fail-closed : uniquement Preview du projet Staging exact. */
export function isGmailSyncSurfaceAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.VERCEL_ENV === "preview" && env.VERCEL_PROJECT_ID === GMAIL_SYNC_ALLOWED_VERCEL_PROJECT_ID
}

async function defaultLoadConnection(input: {
  companyId: string
  connectionId: string
}): Promise<GmailSyncConnectionTarget | null> {
  return prisma.acquisitionGmailConnection.findFirst({
    where: { id: input.connectionId, companyId: input.companyId },
    select: { id: true, companyId: true, active: true },
  })
}

async function defaultFindMessages(args: GmailSyncInspectArgs): Promise<GmailSyncInspectRow[]> {
  return prisma.acquisitionMessage.findMany(args)
}

function isoOrNull(d: unknown): string | null {
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null
}

function safeErrorCode(result: MailSyncResult): string | null {
  const code = result.error?.code
  return typeof code === "string" && SAFE_ERROR_CODE.test(code) ? code : null
}

function safeCount(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0
}

function respond(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } })
}

function refused(status: number, code: string, message: string) {
  return respond(status, { ok: false, code, message })
}

export async function handleTargetedStagingGmailSync(
  req: Request,
  deps: TargetedGmailSyncHandlerDeps = {}
): Promise<Response> {
  const env = deps.env ?? process.env

  if (!isGmailSyncSurfaceAllowed(env)) {
    return refused(403, "HARNESS_SURFACE_FORBIDDEN", "Surface non autorisée pour ce harness")
  }
  if (env[GMAIL_SYNC_ENABLED_FLAG] !== "true") {
    return refused(403, "HARNESS_DISABLED", "Harness désactivé")
  }

  const authenticate = deps.auth ?? (auth as unknown as () => Promise<GmailSyncSession>)
  let session: GmailSyncSession
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
    confirmation === TARGETED_GMAIL_SYNC_CHECK_CONFIRMATION
      ? "CHECK"
      : confirmation === TARGETED_GMAIL_SYNC_RUN_CONFIRMATION
        ? "RUN"
        : confirmation === TARGETED_GMAIL_SYNC_INSPECT_CONFIRMATION
          ? "INSPECT"
          : null
  if (!mode) {
    return refused(400, "CONFIRMATION_REQUIRED", "Confirmation exacte requise")
  }

  const companyId = (env[GMAIL_SYNC_COMPANY_ENV] ?? "").trim()
  const connectionId = (env[GMAIL_SYNC_CONNECTION_ENV] ?? "").trim()
  if (!companyId || !connectionId) {
    return refused(403, "HARNESS_TARGET_UNSET", "Cible company/connexion non configurée")
  }

  if (!session.user.companyId || session.user.companyId !== companyId) {
    return refused(403, "TENANT_MISMATCH", "companyId session ≠ cible harness")
  }

  const loadConnection = deps.loadConnection ?? defaultLoadConnection
  let connection: GmailSyncConnectionTarget | null
  try {
    connection = await loadConnection({ companyId, connectionId })
  } catch {
    return refused(500, "CONNECTION_LOAD_FAILED", "Lecture de la connexion cible impossible")
  }
  if (!connection || connection.id !== connectionId || connection.companyId !== companyId) {
    return refused(404, "CONNECTION_NOT_FOUND", "Connexion Gmail Acquisition cible introuvable pour ce tenant")
  }
  if (connection.active !== true) {
    return refused(409, "CONNECTION_INACTIVE", "Connexion Gmail Acquisition cible inactive")
  }

  if (mode === "CHECK") {
    return respond(200, {
      ok: true,
      harness: HARNESS,
      mode: "CHECK",
      checks: {
        surfaceAllowed: true,
        flagEnabled: true,
        authorized: true,
        tenantMatch: true,
        targetConfigured: true,
        connectionFound: true,
        connectionActive: true,
      },
      gmailCalled: false,
      syncCalled: false,
    })
  }

  if (mode === "INSPECT") {
    // Lecture seule : une seule findMany, cible env uniquement. Aucun Gmail, aucune sync.
    const findMessages = deps.findMessages ?? defaultFindMessages
    let rows: GmailSyncInspectRow[]
    try {
      rows = await findMessages(buildInspectFindManyArgs({ companyId, connectionId }))
    } catch {
      return refused(500, "INSPECT_READ_FAILED", "Lecture des messages cibles impossible")
    }
    const messages = (Array.isArray(rows) ? rows : []).slice(0, INSPECT_MAX_MESSAGES).map((m) => ({
      id: m.id,
      externalMessageId: m.externalMessageId,
      sourceMailboxKey: m.sourceMailboxKey,
      senderEmail: m.senderEmail,
      subject: m.subject,
      receivedAt: isoOrNull(m.receivedAt),
      status: m.status,
      createdAt: isoOrNull(m.createdAt),
      updatedAt: isoOrNull(m.updatedAt),
      draft: m.draft
        ? { id: m.draft.id, status: m.draft.status, createdWorksiteId: m.draft.createdWorksiteId ?? null }
        : null,
      penvenCandidate: isPenvenCandidateSubject(m.subject),
    }))
    return respond(200, {
      ok: true,
      harness: HARNESS,
      mode: "INSPECT",
      readOnly: true,
      gmailCalled: false,
      syncCalled: false,
      count: messages.length,
      penvenFound: messages.some((m) => m.penvenCandidate),
      messages,
    })
  }

  // RUN — un seul appel au service normal, pour la seule connexion configurée.
  const sync = deps.sync ?? syncAcquisitionMailForCompany
  const createProvider = deps.createProvider ?? createGmailMailProviderAdapter
  let result: MailSyncResult
  try {
    result = await sync({
      companyId,
      connectionId,
      provider: createProvider(),
      ingestion: deps.ingestion ?? acquisitionIngestionAdapter,
      cursorRepository: deps.cursorRepository ?? acquisitionScanCursorRepository,
      mailShadow: false,
    })
  } catch {
    return refused(500, "SYNC_FAILED", "Synchronisation ciblée échouée")
  }

  const stats = result?.stats
  return respond(200, {
    ok: true,
    harness: HARNESS,
    mode: "RUN",
    syncCalled: true,
    result: {
      status: typeof result?.status === "string" ? result.status : null,
      skipReason: result?.skipReason ?? null,
      partialReason: result?.partialReason ?? null,
      stats: {
        fetched: safeCount(stats?.fetched),
        ingested: safeCount(stats?.ingested),
        skippedDuplicate: safeCount(stats?.skippedDuplicate),
        rejected: safeCount(stats?.rejected),
        failed: safeCount(stats?.failed),
      },
      hasNextHistoryId: typeof result?.nextHistoryId === "string" && result.nextHistoryId.length > 0,
      errorCode: result ? safeErrorCode(result) : null,
    },
  })
}
