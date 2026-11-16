/**
 * PLAN-ACQ-V2 Lot D / R2 — Adapter Gmail + query lookback fail-closed.
 */

import { AcquisitionSource } from "@prisma/client"
import type { CanonicalMailMessage, MailPage } from "@/lib/acquisition/connector/connector.types"
import type { GmailApiClient } from "@/lib/acquisition/connector/gmail-api.client"
import { createDefaultGmailApiClient } from "@/lib/acquisition/connector/gmail-api.client"
import type { AcquisitionGmailConnectionClient } from "@/lib/acquisition/connector/acquisition-gmail-connection.client"
import { PrismaAcquisitionGmailConnectionClient } from "@/lib/acquisition/connector/acquisition-gmail-connection.client"
import { GmailProviderError } from "@/lib/acquisition/connector/gmail.errors"
import {
  buildAllowedProviderMetadata,
  extractAllowedHeaders,
  sanitizePayloadForMetadata,
} from "@/lib/acquisition/connector/gmail-message-sanitizer"
import {
  extractAttachmentMetadataFromPayload,
  getGmailHeader,
  parseReceivedAt,
} from "@/lib/acquisition/connector/gmail-mime-parser"
import type { ListMessagesPageInput, MailProviderPort } from "@/lib/acquisition/ports/mail-provider.port"
import type { GmailMessageResource } from "@/lib/acquisition/connector/gmail-api.types"
import {
  activePartnerDomainListing,
  type ActivePartnerIdentities,
  type ActivePartnerIdentityListingPort,
} from "@/lib/acquisition/connector/active-partner-domain-listing"

const DEFAULT_LOOKBACK_DAYS = 30

/**
 * Identifiants Gmail déjà enregistrés pour cette boîte (ingérés OU rejetés).
 * Permet de ne pas relire (messages.get) ce qui a déjà été traité : sans cela,
 * un run interrompu (limite de débit, budget) rejoue toute la page au run suivant
 * et une boîte en retard ne rattrape jamais (incident 16/11/2026).
 */
export type KnownGmailMessageIdsPort = (input: {
  companyId: string
  connectionId: string
  externalMessageIds: string[]
}) => Promise<Set<string>>

export interface GmailMailProviderAdapterDeps {
  connectionClient?: AcquisitionGmailConnectionClient
  apiClient?: GmailApiClient
  lookbackDays?: number
  domainListing?: ActivePartnerIdentityListingPort
  /** Absent → aucun filtrage (comportement historique, tests). */
  knownMessageIds?: KnownGmailMessageIdsPort
}

/**
 * Implémentation Prisma : même boîte + curseur legacy "" (anti-doublon historique).
 * Exception : un message rejeté faute d'expéditeur partenaire dont l'expéditeur
 * est AUJOURD'HUI partenaire (domaine/e-mail ajouté au registre) n'est pas « connu » :
 * il est relu pour être promu en consultation.
 */
export const prismaKnownGmailMessageIds: KnownGmailMessageIdsPort = async ({
  companyId,
  connectionId,
  externalMessageIds,
}) => {
  if (externalMessageIds.length === 0) return new Set()
  const { prisma } = await import("@/lib/prisma")
  const rows = await prisma.acquisitionMessage.findMany({
    where: {
      companyId,
      source: AcquisitionSource.GMAIL,
      sourceMailboxKey: { in: [connectionId, ""] },
      externalMessageId: { in: externalMessageIds },
    },
    select: { externalMessageId: true, status: true, lastErrorCode: true, senderEmail: true, senderDomain: true },
  })
  const rejectedNotEligible = rows.some(
    (r) => r.status === "REJECTED" && r.lastErrorCode === "SENDER_NOT_ELIGIBLE"
  )
  const identities = rejectedNotEligible
    ? await activePartnerDomainListing.listActiveIdentities(companyId)
    : null
  return new Set(
    rows
      .filter((r) => !(identities && isNowEligibleRejection(r, identities)))
      .map((r) => r.externalMessageId)
  )
}

/** Rejet « expéditeur non partenaire » levé depuis par le registre. */
export function isNowEligibleRejection(
  row: { status: string; lastErrorCode: string | null; senderEmail: string; senderDomain: string },
  identities: ActivePartnerIdentities
): boolean {
  if (row.status !== "REJECTED" || row.lastErrorCode !== "SENDER_NOT_ELIGIBLE") return false
  const domain = row.senderDomain.trim().toLowerCase()
  const email = row.senderEmail.trim().toLowerCase()
  return (
    (domain !== "" && identities.domains.some((d) => d.toLowerCase() === domain)) ||
    identities.emails.some((e) => e.toLowerCase() === email)
  )
}

function formatGmailAfterDate(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, "0")
  const day = String(d.getUTCDate()).padStart(2, "0")
  return `${y}/${m}/${day}`
}

const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/i
const EMAIL_RE =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i

export function escapeGmailQueryTerm(term: string): string {
  if (/[\s"()]/.test(term)) {
    return `"${term.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
  }
  return term
}

export type GmailLookbackQueryResult =
  | { ok: true; query: string }
  | { ok: false; code: "NO_ACTIVE_PARTNER_IDENTITIES" }

function isActivePartnerIdentities(
  value: unknown
): value is ActivePartnerIdentities {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }
  const rec = value as Record<string, unknown>
  return Array.isArray(rec.domains) && Array.isArray(rec.emails)
}

/**
 * Lookback fail-closed : jamais `after:` seul.
 * Mixte : after:… (from:email OR from:@domain …)
 * Compat : `readonly string[]` = domaines seuls (legacy).
 */
export function buildAcquisitionGmailLookbackQuery(
  lookbackDays: number,
  identities?: ActivePartnerIdentities | readonly string[]
): GmailLookbackQueryResult {
  const after = `after:${formatGmailAfterDate(lookbackDays)}`

  let domains: string[] = []
  let emails: string[] = []
  if (Array.isArray(identities)) {
    domains = [...identities]
  } else if (isActivePartnerIdentities(identities)) {
    domains = [...identities.domains]
    emails = [...identities.emails]
  }

  const normDomains = [
    ...new Set(
      domains
        .map((d) => d.trim().toLowerCase().replace(/^@+/, ""))
        .filter((d) => DOMAIN_RE.test(d))
    ),
  ].sort()
  const normEmails = [
    ...new Set(
      emails.map((e) => e.trim().toLowerCase()).filter((e) => EMAIL_RE.test(e))
    ),
  ].sort()

  if (normDomains.length === 0 && normEmails.length === 0) {
    return { ok: false, code: "NO_ACTIVE_PARTNER_IDENTITIES" }
  }

  const fromParts = [
    ...normEmails.map((e) => `from:${escapeGmailQueryTerm(e)}`),
    ...normDomains.map((d) => `from:@${d}`),
  ]
  return { ok: true, query: `${after} (${fromParts.join(" OR ")})` }
}

function mapGmailResourceToCanonical(resource: GmailMessageResource): CanonicalMailMessage {
  const sanitizedPayload = sanitizePayloadForMetadata(resource.payload)
  const headers = extractAllowedHeaders(sanitizedPayload?.headers)

  return {
    externalMessageId: resource.id,
    threadId: resource.threadId ?? null,
    fromHeader: getGmailHeader(headers, "From"),
    subject: getGmailHeader(headers, "Subject"),
    receivedAt: parseReceivedAt(
      resource.internalDate,
      getGmailHeader(headers, "Date")
    ),
    labels: resource.labelIds ?? [],
    snippet: resource.snippet ?? null,
    attachments: extractAttachmentMetadataFromPayload(sanitizedPayload),
    providerMetadata: buildAllowedProviderMetadata(resource),
  }
}

const emptyIdentityListing: ActivePartnerIdentityListingPort = {
  listActiveIdentities: async () => ({ domains: [], emails: [] }),
  listActiveDomains: async () => [],
}

export class GmailMailProviderAdapter implements MailProviderPort {
  readonly source = AcquisitionSource.GMAIL

  private readonly connectionClient: AcquisitionGmailConnectionClient
  private readonly apiClient: GmailApiClient
  private readonly lookbackDays: number
  private readonly domainListing: ActivePartnerIdentityListingPort
  private readonly knownMessageIds?: KnownGmailMessageIdsPort

  constructor(deps: GmailMailProviderAdapterDeps = {}) {
    this.connectionClient =
      deps.connectionClient ?? new PrismaAcquisitionGmailConnectionClient()
    this.apiClient = deps.apiClient ?? createDefaultGmailApiClient()
    this.lookbackDays =
      deps.lookbackDays ??
      Number(process.env.ACQUISITION_GMAIL_LOOKBACK_DAYS ?? DEFAULT_LOOKBACK_DAYS)
    this.domainListing = deps.domainListing ?? emptyIdentityListing
    this.knownMessageIds = deps.knownMessageIds
  }

  /** Retire les ids déjà traités ; une panne de lecture n'empêche jamais la synchro. */
  private async filterUnknownIds(companyId: string, connectionId: string, ids: string[]): Promise<string[]> {
    if (!this.knownMessageIds || ids.length === 0) return ids
    try {
      const known = await this.knownMessageIds({ companyId, connectionId, externalMessageIds: ids })
      return known.size === 0 ? ids : ids.filter((id) => !known.has(id))
    } catch {
      return ids
    }
  }

  private async resolveLookbackQuery(companyId: string): Promise<string> {
    const identities = await this.domainListing.listActiveIdentities(companyId)
    const built = buildAcquisitionGmailLookbackQuery(this.lookbackDays, identities)
    if (!built.ok) {
      throw new GmailProviderError({
        code: "NO_ACTIVE_PARTNER_IDENTITIES",
        message: "Aucune identité partenaire active (domaine ou email)",
        retryable: false,
        global: false,
      })
    }
    return built.query
  }

  async listMessagesPage(input: ListMessagesPageInput): Promise<MailPage> {
    const { companyId, connectionId, cursor, pageSize, pageToken, paginationMode } = input
    if (!connectionId) {
      throw new GmailProviderError({
        code: "GMAIL_NOT_CONNECTED",
        message: "connectionId requis pour le scan Gmail Acquisition",
        retryable: false,
        global: true,
      })
    }
    const accessToken = await this.connectionClient.getValidAccessToken({
      companyId,
      connectionId,
    })

    if (paginationMode === "lookback" || !cursor) {
      return this.listViaQuery(
        accessToken,
        await this.resolveLookbackQuery(companyId),
        pageSize,
        pageToken ?? undefined,
        { companyId, connectionId }
      )
    }

    try {
      return await this.listViaHistory(
        accessToken,
        cursor,
        pageSize,
        pageToken ?? undefined,
        { companyId, connectionId }
      )
    } catch (error) {
      if (error instanceof GmailProviderError && error.code === "GMAIL_HISTORY_EXPIRED") {
        return this.listViaQuery(
          accessToken,
          await this.resolveLookbackQuery(companyId),
          pageSize,
          pageToken ?? undefined,
          { companyId, connectionId }
        )
      }
      throw error
    }
  }

  private async listViaHistory(
    accessToken: string,
    startHistoryId: string,
    maxResults: number,
    pageToken: string | undefined,
    scope: { companyId: string; connectionId: string }
  ): Promise<MailPage> {
    const historyData = await this.apiClient.listHistory(
      accessToken,
      startHistoryId,
      maxResults,
      pageToken
    )

    const messageIds = dedupeHistoryMessageIds(historyData.history ?? [])
    const idsForPage = messageIds.slice(0, maxResults)
    const toFetch = await this.filterUnknownIds(scope.companyId, scope.connectionId, idsForPage)
    const messages = await this.fetchAndMapMessages(accessToken, toFetch)

    const nextPageToken = historyData.nextPageToken ?? null
    const hasMore = Boolean(nextPageToken) || messageIds.length > maxResults

    return {
      messages,
      nextPageToken,
      nextHistoryId: historyData.historyId ?? null,
      hasMore,
      paginationMode: "history",
    }
  }

  private async listViaQuery(
    accessToken: string,
    query: string,
    maxResults: number,
    pageToken: string | undefined,
    scope: { companyId: string; connectionId: string }
  ): Promise<MailPage> {
    const listData = await this.apiClient.listMessages(
      accessToken,
      query,
      maxResults,
      pageToken
    )
    const ids = (listData.messages ?? []).map((m) => m.id)
    const toFetch = await this.filterUnknownIds(scope.companyId, scope.connectionId, ids)
    const messages = await this.fetchAndMapMessages(accessToken, toFetch)

    let nextHistoryId: string | null = null
    try {
      const profile = await this.apiClient.getProfile(accessToken)
      nextHistoryId = profile.historyId ?? null
    } catch {
      // optional
    }

    const nextPageToken = listData.nextPageToken ?? null

    return {
      messages,
      nextPageToken,
      nextHistoryId,
      hasMore: Boolean(nextPageToken),
      paginationMode: "lookback",
    }
  }

  private async fetchAndMapMessages(
    accessToken: string,
    messageIds: string[]
  ): Promise<CanonicalMailMessage[]> {
    const messages: CanonicalMailMessage[] = []

    for (const messageId of messageIds) {
      try {
        const resource = await this.apiClient.getMessage(accessToken, messageId)
        if (!resource?.id || !resource.payload) {
          throw new GmailProviderError({
            code: "GMAIL_MESSAGE_PARSE_ERROR",
            message: "Message Gmail sans payload exploitable",
            retryable: false,
            global: false,
            messageId,
          })
        }
        messages.push(mapGmailResourceToCanonical(resource))
      } catch (error) {
        if (error instanceof GmailProviderError) {
          if (
            error.code === "GMAIL_RATE_LIMITED" ||
            error.code === "GMAIL_UNAUTHORIZED" ||
            (error.code === "GMAIL_UNAVAILABLE" && error.retryable)
          ) {
            throw error
          }
          continue
        }
        continue
      }
    }

    return messages
  }
}

function dedupeHistoryMessageIds(
  history: { messagesAdded?: { message?: { id?: string } }[] }[]
): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const record of history) {
    for (const added of record.messagesAdded ?? []) {
      const id = added.message?.id
      if (id && !seen.has(id)) {
        seen.add(id)
        ids.push(id)
      }
    }
  }
  return ids
}

export function createGmailMailProviderAdapter(
  deps?: GmailMailProviderAdapterDeps
): MailProviderPort {
  return new GmailMailProviderAdapter({
    domainListing: activePartnerDomainListing,
    knownMessageIds: prismaKnownGmailMessageIds,
    ...deps,
  })
}
