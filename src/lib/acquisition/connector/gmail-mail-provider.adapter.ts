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

const DEFAULT_LOOKBACK_DAYS = 30

export interface GmailMailProviderAdapterDeps {
  connectionClient?: GmailConnectionClient
  apiClient?: GmailApiClient
  lookbackDays?: number
}

function formatGmailAfterDate(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, "0")
  const day = String(d.getUTCDate()).padStart(2, "0")
  return `${y}/${m}/${day}`
}

/** Requête scan initial / fallback — fenêtre temporelle uniquement (pas de filtre expéditeur). */
export function buildAcquisitionGmailLookbackQuery(lookbackDays: number): string {
  return `after:${formatGmailAfterDate(lookbackDays)}`
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

export class GmailMailProviderAdapter implements MailProviderPort {
  readonly source = AcquisitionSource.GMAIL

  private readonly connectionClient: GmailConnectionClient
  private readonly apiClient: GmailApiClient
  private readonly lookbackDays: number

  constructor(deps: GmailMailProviderAdapterDeps = {}) {
    this.connectionClient = deps.connectionClient ?? new PrismaGmailConnectionClient()
    this.apiClient = deps.apiClient ?? new FetchGmailApiClient()
    this.lookbackDays = deps.lookbackDays ?? Number(process.env.ACQUISITION_GMAIL_LOOKBACK_DAYS ?? DEFAULT_LOOKBACK_DAYS)
  }

  async listMessagesPage(input: ListMessagesPageInput): Promise<MailPage> {
    const { companyId, cursor, pageSize, pageToken, paginationMode } = input
    const accessToken = await this.connectionClient.getValidAccessToken(companyId)

    if (paginationMode === "lookback" || !cursor) {
      return this.listViaQuery(
        accessToken,
        buildAcquisitionGmailLookbackQuery(this.lookbackDays),
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
          buildAcquisitionGmailLookbackQuery(this.lookbackDays),
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
    const hasMore =
      Boolean(nextPageToken) || messageIds.length > maxResults

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
    const listData = await this.apiClient.listMessages(accessToken, query, maxResults, pageToken)
    const ids = (listData.messages ?? []).map((m) => m.id)
    const messages = await this.fetchAndMapMessages(accessToken, ids)

    let nextHistoryId: string | null = null
    try {
      const profile = await this.apiClient.getProfile(accessToken)
      nextHistoryId = profile.historyId ?? null
    } catch {
      // Profil optionnel pour nextHistoryId en fallback lookback
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
  return new GmailMailProviderAdapter(deps)
}
