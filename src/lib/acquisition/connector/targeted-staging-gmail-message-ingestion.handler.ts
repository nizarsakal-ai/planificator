/**
 * Harness temporaire Staging Preview — ingestion CIBLÉE d'UN message Gmail réel (Biscuiterie Penven)
 * via le pipeline NORMAL (registerIncomingMessage). Fail-closed. Cible via env uniquement.
 *
 * CHECK : gardes + connexion cible active. Aucun token, aucun Gmail, aucune ingestion, aucune écriture.
 * RUN   : identités partenaires fail-closed (buildAcquisitionGmailLookbackQuery) + expéditeur cible
 *         autorisé ; requête after:<lookback> from:<expéditeur exact> subject:Consultation, UNE page
 *         messages.list (maxResults ≤ 10, aucun pageToken), messages.get par candidat (≤ 10),
 *         mapping canonique normal, correspondance EXACTE du sujet attendu ; exactement 1 → UN appel
 *         registerIncomingMessage(mapGmailMessageToAcquisitionInput(msg, companyId, connectionId)).
 * Jamais : History API, curseur (lecture / création / écriture), sync, pagination, retry, autre mailbox.
 * Écritures possibles en RUN : refresh OAuth normal (accessToken / tokenExpiry) et l'ingestion normale.
 * Sortie : identifiants internes + compteurs. Aucun token, corps, PJ, rawMetadata ni message d'erreur brut.
 */

import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { PrismaAcquisitionGmailConnectionClient } from "@/lib/acquisition/connector/acquisition-gmail-connection.client"
import { FetchGmailApiClient, type GmailApiClient } from "@/lib/acquisition/connector/gmail-api.client"
import type { GmailMessageResource } from "@/lib/acquisition/connector/gmail-api.types"
import {
  buildAcquisitionGmailLookbackQuery,
  escapeGmailQueryTerm,
  mapGmailResourceToCanonical,
} from "@/lib/acquisition/connector/gmail-mail-provider.adapter"
import { mapGmailMessageToAcquisitionInput } from "@/lib/acquisition/connector/gmail-message.mapper"
import {
  activePartnerDomainListing,
  type ActivePartnerIdentities,
} from "@/lib/acquisition/connector/active-partner-domain-listing"
import { GmailProviderError } from "@/lib/acquisition/connector/gmail.errors"
import { acquisitionIngestionAdapter } from "@/lib/acquisition/ports/acquisition-ingestion.adapter"
import type { AcquisitionIngestionPort } from "@/lib/acquisition/ports/acquisition-ingestion.port"

export const TARGETED_GMAIL_MESSAGE_INGESTION_CHECK_CONFIRMATION =
  "CHECK_TARGETED_STAGING_GMAIL_MESSAGE_INGESTION" as const
export const TARGETED_GMAIL_MESSAGE_INGESTION_RUN_CONFIRMATION =
  "RUN_TARGETED_STAGING_GMAIL_MESSAGE_INGESTION" as const

/** planificator-staging (Preview only). */
export const GMAIL_MESSAGE_INGESTION_ALLOWED_VERCEL_PROJECT_ID = "prj_CRp6XttdXjBjPMjJMSMbsUp6hwVD"

export const GMAIL_MESSAGE_INGESTION_ENABLED_FLAG = "TARGETED_STAGING_GMAIL_MESSAGE_INGESTION_ENABLED"
/** Cible : mêmes variables que le harness de sync ciblée (connexion Acquisition HYLIGHT). */
export const GMAIL_MESSAGE_INGESTION_COMPANY_ENV = "TARGETED_STAGING_GMAIL_SYNC_COMPANY_ID"
export const GMAIL_MESSAGE_INGESTION_CONNECTION_ENV = "TARGETED_STAGING_GMAIL_SYNC_CONNECTION_ID"

/** Message attendu (sujet exact, comparé après normalisation minimale). */
export const TARGET_EXPECTED_SUBJECT = "Consultation démontage_BISCUITERIE PENVEN_20/10 et 21/10"
/**
 * Filtre sujet Gmail : un seul terme autonome du sujet réel, « Consultation », utilisé uniquement
 * comme présélection bornée (avec le filtre expéditeur exact, la fenêtre de 7 jours et maxResults ≤ 10).
 * L'autorité finale reste isExactTargetSubject() sur le sujet canonique après messages.get.
 */
export const TARGET_SUBJECT_QUERY_TERM = "Consultation"
/**
 * Expéditeur exact du message cible, utilisé comme seul filtre from: de ce harness.
 * Utilisable uniquement s'il reste autorisé par les identités partenaires actives
 * (adresse exacte dans emails, ou son domaine dans domains) ; sinon fail-closed.
 */
export const TARGET_SENDER_EMAIL = "jeanlaurentcazala@lauralu.fr"
/** Fenêtre de recherche (jours) — message reçu le 01/10/2026. */
export const TARGET_LOOKBACK_DAYS = 7
/** Borne stricte d'une unique page Gmail. */
export const TARGET_MAX_RESULTS = 10

const HARNESS = "targeted-staging-gmail-message-ingestion"

/** Seule clé acceptée dans le body. */
const ALLOWED_BODY_KEYS = new Set(["confirmation"])

/** Clés de ciblage / recherche interdites, comparées après normalisation (minuscules, sans « _ » / « - »). */
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
    "query",
    "q",
    "search",
    "messageId",
    "externalMessageId",
    "gmailMessageId",
    "acquisitionMessageId",
    "subject",
    "draftId",
    "target",
    "maxResults",
    "pageToken",
    "lookbackDays",
  ].map(normalizeKey)
)

/** Codes provider exposables (jamais le message brut). */
const EXPOSABLE_PROVIDER_CODES = new Set<string>([
  "GMAIL_NOT_CONNECTED",
  "GMAIL_TOKEN_REFRESH_FAILED",
  "GMAIL_UNAUTHORIZED",
  "GMAIL_RATE_LIMITED",
  "GMAIL_UNAVAILABLE",
  "GMAIL_MESSAGE_NOT_FOUND",
])

export type GmailMessageIngestionSession = {
  user: { id: string; role: string; companyId: string | null }
} | null

export type GmailMessageIngestionConnection = { id: string; companyId: string; active: boolean }

/** Sous-ensemble Gmail autorisé : liste + lecture. Jamais history / attachments / profile. */
export type TargetedGmailReadClient = Pick<GmailApiClient, "listMessages" | "getMessage">

export type TargetedGmailMessageIngestionHandlerDeps = {
  auth?: () => Promise<GmailMessageIngestionSession>
  env?: Record<string, string | undefined>
  loadConnection?: (input: { companyId: string; connectionId: string }) => Promise<GmailMessageIngestionConnection | null>
  getValidAccessToken?: (lookup: { companyId: string; connectionId: string }) => Promise<string>
  gmail?: TargetedGmailReadClient
  listActiveIdentities?: (companyId: string) => Promise<ActivePartnerIdentities>
  ingestion?: AcquisitionIngestionPort
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "")
}

/** Normalisation minimale : NFD sans diacritiques, minuscules, espaces compactés, trim. */
export function normalizeSubjectForMatch(subject: unknown): string {
  if (typeof subject !== "string") return ""
  return subject
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

export function isExactTargetSubject(subject: unknown): boolean {
  const normalized = normalizeSubjectForMatch(subject)
  return normalized.length > 0 && normalized === normalizeSubjectForMatch(TARGET_EXPECTED_SUBJECT)
}

/**
 * L'expéditeur cible est-il autorisé par les identités partenaires actives ?
 * Adresse exacte dans emails, ou son domaine exact dans domains (comparaison trim + minuscules,
 * « @ » de tête toléré comme dans le builder global). Toute autre situation → false.
 */
export function isTargetSenderAuthorized(identities: ActivePartnerIdentities): boolean {
  const sender = TARGET_SENDER_EMAIL.toLowerCase()
  const domain = sender.slice(sender.lastIndexOf("@") + 1)
  const emails = Array.isArray(identities?.emails) ? identities.emails : []
  const domains = Array.isArray(identities?.domains) ? identities.domains : []
  const emailOk = emails.some((e) => typeof e === "string" && e.trim().toLowerCase() === sender)
  const domainOk = domains.some(
    (d) => typeof d === "string" && d.trim().toLowerCase().replace(/^@+/, "") === domain
  )
  return emailOk || domainOk
}

export type TargetedPenvenQueryResult =
  | { ok: true; query: string }
  | { ok: false; code: "NO_ACTIVE_PARTNER_IDENTITIES" | "TARGET_SENDER_NOT_AUTHORIZED" | "QUERY_BUILD_FAILED" }

/**
 * Requête Gmail ciblée : after:<date> from:<expéditeur exact> subject:Consultation.
 * 1. builder global INCHANGÉ (fail-closed partenaires) : aucune identité valide → refus ;
 * 2. expéditeur cible autorisé par les identités actives, sinon refus ;
 * 3. la date « after:YYYY/MM/DD » est reprise telle quelle du builder global (même calcul lookback),
 *    sa clause from:… est remplacée par le seul expéditeur exact (aucun from:@domaine, aucun OR).
 */
export function buildTargetedPenvenQuery(identities: ActivePartnerIdentities): TargetedPenvenQueryResult {
  const base = buildAcquisitionGmailLookbackQuery(TARGET_LOOKBACK_DAYS, identities)
  if (!base.ok) return base
  if (!isTargetSenderAuthorized(identities)) return { ok: false, code: "TARGET_SENDER_NOT_AUTHORIZED" }
  const after = /^(after:\d{4}\/\d{2}\/\d{2}) /.exec(base.query)?.[1]
  if (!after) return { ok: false, code: "QUERY_BUILD_FAILED" }
  return {
    ok: true,
    query: `${after} from:${escapeGmailQueryTerm(TARGET_SENDER_EMAIL)} subject:${escapeGmailQueryTerm(TARGET_SUBJECT_QUERY_TERM)}`,
  }
}

/** Runtime fail-closed : uniquement Preview du projet Staging exact. */
export function isGmailMessageIngestionSurfaceAllowed(
  env: Record<string, string | undefined> = process.env
): boolean {
  return (
    env.VERCEL_ENV === "preview" && env.VERCEL_PROJECT_ID === GMAIL_MESSAGE_INGESTION_ALLOWED_VERCEL_PROJECT_ID
  )
}

async function defaultLoadConnection(input: {
  companyId: string
  connectionId: string
}): Promise<GmailMessageIngestionConnection | null> {
  return prisma.acquisitionGmailConnection.findFirst({
    where: { id: input.connectionId, companyId: input.companyId },
    select: { id: true, companyId: true, active: true },
  })
}

function defaultGetValidAccessToken(lookup: { companyId: string; connectionId: string }): Promise<string> {
  return new PrismaAcquisitionGmailConnectionClient().getValidAccessToken(lookup)
}

function safeProviderCode(err: unknown): string | null {
  return err instanceof GmailProviderError && EXPOSABLE_PROVIDER_CODES.has(err.code) ? err.code : null
}

function respond(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } })
}

function refused(status: number, code: string, message: string, extra?: Record<string, unknown>) {
  return respond(status, { ok: false, code, message, ...extra })
}

export async function handleTargetedStagingGmailMessageIngestion(
  req: Request,
  deps: TargetedGmailMessageIngestionHandlerDeps = {}
): Promise<Response> {
  const env = deps.env ?? process.env

  if (!isGmailMessageIngestionSurfaceAllowed(env)) {
    return refused(403, "HARNESS_SURFACE_FORBIDDEN", "Surface non autorisée pour ce harness")
  }
  if (env[GMAIL_MESSAGE_INGESTION_ENABLED_FLAG] !== "true") {
    return refused(403, "HARNESS_DISABLED", "Harness désactivé")
  }

  const authenticate = deps.auth ?? (auth as unknown as () => Promise<GmailMessageIngestionSession>)
  let session: GmailMessageIngestionSession
  try {
    session = await authenticate()
  } catch {
    return refused(401, "UNAUTHORIZED", "Non authentifié")
  }
  if (!session?.user) return refused(401, "UNAUTHORIZED", "Non authentifié")
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
    confirmation === TARGETED_GMAIL_MESSAGE_INGESTION_CHECK_CONFIRMATION
      ? "CHECK"
      : confirmation === TARGETED_GMAIL_MESSAGE_INGESTION_RUN_CONFIRMATION
        ? "RUN"
        : null
  if (!mode) return refused(400, "CONFIRMATION_REQUIRED", "Confirmation exacte requise")

  const companyId = (env[GMAIL_MESSAGE_INGESTION_COMPANY_ENV] ?? "").trim()
  const connectionId = (env[GMAIL_MESSAGE_INGESTION_CONNECTION_ENV] ?? "").trim()
  if (!companyId || !connectionId) {
    return refused(403, "HARNESS_TARGET_UNSET", "Cible company/connexion non configurée")
  }
  if (!session.user.companyId || session.user.companyId !== companyId) {
    return refused(403, "TENANT_MISMATCH", "companyId session ≠ cible harness")
  }

  const loadConnection = deps.loadConnection ?? defaultLoadConnection
  let connection: GmailMessageIngestionConnection | null
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
    return respond(200, { ok: true, harness: HARNESS, mode: "CHECK", gmailCalled: false, ingestionCalled: false })
  }

  // ---- RUN ----
  const ingestion = deps.ingestion ?? acquisitionIngestionAdapter
  if (!ingestion.isEnabled()) {
    return refused(409, "INGESTION_DISABLED", "Ingestion Acquisition désactivée — aucun appel Gmail", {
      gmailCalled: false,
      ingestionCalled: false,
    })
  }

  const listActiveIdentities =
    deps.listActiveIdentities ?? ((id: string) => activePartnerDomainListing.listActiveIdentities(id))
  let identities: ActivePartnerIdentities
  try {
    identities = await listActiveIdentities(companyId)
  } catch {
    return refused(500, "PARTNER_IDENTITIES_LOAD_FAILED", "Lecture des identités partenaires impossible", {
      gmailCalled: false,
      ingestionCalled: false,
    })
  }
  const built = buildTargetedPenvenQuery(identities)
  if (!built.ok) {
    const message =
      built.code === "TARGET_SENDER_NOT_AUTHORIZED"
        ? "Expéditeur cible non autorisé par les identités partenaires actives — recherche Gmail refusée"
        : built.code === "QUERY_BUILD_FAILED"
          ? "Construction de la requête Gmail ciblée impossible — recherche refusée"
          : "Aucune identité partenaire active — recherche Gmail refusée"
    return refused(409, built.code, message, {
      gmailCalled: false,
      ingestionCalled: false,
    })
  }

  const getValidAccessToken = deps.getValidAccessToken ?? defaultGetValidAccessToken
  const gmail = deps.gmail ?? new FetchGmailApiClient()

  let accessToken: string
  try {
    accessToken = await getValidAccessToken({ companyId, connectionId })
  } catch (err) {
    return refused(502, "GMAIL_TOKEN_UNAVAILABLE", "Token Gmail Acquisition indisponible", {
      providerCode: safeProviderCode(err),
      gmailCalled: false,
      ingestionCalled: false,
    })
  }
  if (typeof accessToken !== "string" || !accessToken) {
    return refused(502, "GMAIL_TOKEN_UNAVAILABLE", "Token Gmail Acquisition indisponible", {
      providerCode: null,
      gmailCalled: false,
      ingestionCalled: false,
    })
  }

  // Une seule page, sans pageToken : la pagination n'est jamais suivie.
  let listedIds: string[]
  try {
    const page = await gmail.listMessages(accessToken, built.query, TARGET_MAX_RESULTS)
    listedIds = [
      ...new Set(
        (page?.messages ?? [])
          .map((m) => (typeof m?.id === "string" ? m.id.trim() : ""))
          .filter((id) => id.length > 0)
      ),
    ].slice(0, TARGET_MAX_RESULTS)
  } catch (err) {
    return refused(502, "GMAIL_LIST_FAILED", "Recherche Gmail ciblée impossible", {
      providerCode: safeProviderCode(err),
      gmailCalled: true,
      ingestionCalled: false,
    })
  }

  const exact: Array<ReturnType<typeof mapGmailResourceToCanonical>> = []
  for (const id of listedIds) {
    let resource: GmailMessageResource
    try {
      resource = await gmail.getMessage(accessToken, id)
    } catch (err) {
      return refused(502, "GMAIL_MESSAGE_FETCH_FAILED", "Lecture Gmail d'un candidat impossible", {
        providerCode: safeProviderCode(err),
        gmailCalled: true,
        ingestionCalled: false,
      })
    }
    if (!resource || resource.id !== id) {
      return refused(502, "GMAIL_MESSAGE_IDENTITY_MISMATCH", "Message Gmail retourné ≠ candidat", {
        gmailCalled: true,
        ingestionCalled: false,
      })
    }
    const canonical = mapGmailResourceToCanonical(resource)
    if (isExactTargetSubject(canonical.subject)) exact.push(canonical)
  }

  const counts = { candidateCount: listedIds.length, matchedCount: exact.length }
  if (exact.length === 0) {
    return refused(404, "TARGET_MESSAGE_NOT_FOUND", "Aucun message Gmail exact pour la cible — aucune ingestion", {
      gmailCalled: true,
      ingestionCalled: false,
      ...counts,
    })
  }
  if (exact.length > 1) {
    return refused(409, "TARGET_MESSAGE_AMBIGUOUS", "Plusieurs messages Gmail exacts — aucune ingestion", {
      gmailCalled: true,
      ingestionCalled: false,
      ...counts,
    })
  }

  // Exactement un : pipeline normal, sourceMailboxKey = connectionId (comme la sync).
  const registerInput = mapGmailMessageToAcquisitionInput(exact[0]!, companyId, connectionId)
  let result: Awaited<ReturnType<AcquisitionIngestionPort["registerIncomingMessage"]>>
  try {
    result = await ingestion.registerIncomingMessage(registerInput)
  } catch {
    return refused(500, "INGESTION_FAILED", "Ingestion normale échouée", {
      gmailCalled: true,
      ingestionCalled: true,
      ...counts,
    })
  }

  return respond(200, {
    ok: true,
    harness: HARNESS,
    mode: "RUN",
    gmailCalled: true,
    ingestionCalled: true,
    ...counts,
    outcome: result.outcome,
    created: result.created,
    messageId: result.messageId,
    draftId: result.draftId,
    rejectionCode: result.outcome === "REJECTED" ? result.errorCode : null,
    attachmentCount: registerInput.attachments?.length ?? 0,
  })
}
