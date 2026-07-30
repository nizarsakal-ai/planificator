/**
 * PLAN-ACQ-V2 Lot D / R2 — Adapter Gmail + query lookback fail-closed.
 */

import { AcquisitionSource } from "@prisma/client"
import type { CanonicalMailMessage, MailPage } from "@/lib/acquisition/connector/connector.types"
import type { GmailApiClient } from "@/lib/acquisition/connector/gmail-api.client"
import { FetchGmailApiClient } from "@/lib/acquisition/connector/gmail-api.client"
import type { GmailConnectionClient } from "@/lib/acquisition/connector/gmail-connection.client"
import { PrismaGmailConnectionClient } from "@/lib/acquisition/connector/gmail-connection.client"
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

export interface GmailMailProviderAdapterDeps {
  connectionClient?: GmailConnectionClient
  apiClient?: GmailApiClient
  lookbackDays?: number
  domainListing?: ActivePartnerIdentityListingPort
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

  private readonly connectionClient: GmailConnectionClient
  private readonly apiClient: GmailApiClient
  private readonly lookbackDays: number
  private readonly domainListing: ActivePartnerIdentityListingPort

  constructor(deps: GmailMailProviderAdapterDeps = {}) {
    this.connectionClient = deps.connectionClient ?? new PrismaGmailConnectionClient()
    this.apiClient = deps.apiClient ?? new FetchGmailApiClient()
    this.lookbackDays =
      deps.lookbackDays ??
      Number(process.env.ACQUISITION_GMAIL_LOOKBACK_DAYS ?? DEFAULT_LOOKBACK_DAYS)
    this.domainListing = deps.domainListing ?? emptyIdentityListing
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
    const { companyId, cursor, pageSize, pageToken, paginationMode } = input
    const accessToken = await this.connectionClient.getValidAccessToken(companyId)

    if (paginationMode === "lookback" || !cursor) {
      return this.listViaQuery(
        accessToken,
        await this.resolveLookbackQuery(companyId),
        pageSize,
        pageToken ?? undefined
      )
    }

    try {
      return await this.listViaHistory(
        accessToken,
        cursor,
        pageSize,
        pageToken ?? undefined
      )
    } catch (error) {
      if (error instanceof GmailProviderError && error.code === "GMAIL_HISTORY_EXPIRED") {
        return this.listViaQuery(
          accessToken,
          await this.resolveLookbackQuery(companyId),
          pageSize,
          pageToken ?? undefined
        )
      }
      throw error
    }
  }

  private async listViaHistory(
    accessToken: string,
    startHistoryId: string,
    maxResults: number,
    pageToken?: string
  ): Promise<MailPage> {
    const historyData = await this.apiClient.listHistory(
      accessToken,
      startHistoryId,
      maxResults,
      pageToken
    )

    const messageIds = dedupeHistoryMessageIds(historyData.history ?? [])
    const idsForPage = messageIds.slice(0, maxResults)
    const messages = await this.fetchAndMapMessages(accessToken, idsForPage)

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
    pageToken?: string
  ): Promise<MailPage> {
    const listData = await this.apiClient.listMessages(
      accessToken,
      query,
      maxResults,
      pageToken
    )
    const ids = (listData.messages ?? []).map((m) => m.id)
    const messages = await this.fetchAndMapMessages(accessToken, ids)

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
    ...deps,
  })
}
