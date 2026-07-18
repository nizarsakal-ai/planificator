import type {
  GmailAttachmentResource,
  GmailHistoryListResponse,
  GmailMessageResource,
  GmailMessagesListResponse,
  GmailProfileResponse,
} from "@/lib/acquisition/connector/gmail-api.types"
import { GmailProviderError, mapHttpStatusToGmailError } from "@/lib/acquisition/connector/gmail.errors"

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"

export interface GmailApiClient {
  getProfile(accessToken: string): Promise<GmailProfileResponse>
  listHistory(
    accessToken: string,
    startHistoryId: string,
    maxResults: number,
    pageToken?: string
  ): Promise<GmailHistoryListResponse>
  listMessages(
    accessToken: string,
    query: string,
    maxResults: number,
    pageToken?: string
  ): Promise<GmailMessagesListResponse>
  getMessage(accessToken: string, messageId: string): Promise<GmailMessageResource>
  getAttachment(
    accessToken: string,
    messageId: string,
    attachmentId: string
  ): Promise<GmailAttachmentResource>
}

async function readGmailJson<T>(res: Response, context: "list" | "history" | "message" | "profile"): Promise<T> {
  if (!res.ok) {
    throw mapHttpStatusToGmailError(res.status, context)
  }
  return (await res.json()) as T
}

export class FetchGmailApiClient implements GmailApiClient {
  async getProfile(accessToken: string): Promise<GmailProfileResponse> {
    const res = await fetch(`${GMAIL_BASE}/profile`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    return readGmailJson<GmailProfileResponse>(res, "profile")
  }

  async listHistory(
    accessToken: string,
    startHistoryId: string,
    maxResults: number,
    pageToken?: string
  ): Promise<GmailHistoryListResponse> {
    const params = new URLSearchParams({
      startHistoryId,
      maxResults: String(maxResults),
      historyTypes: "messageAdded",
    })
    if (pageToken) params.set("pageToken", pageToken)

    const res = await fetch(`${GMAIL_BASE}/history?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    return readGmailJson<GmailHistoryListResponse>(res, "history")
  }

  async listMessages(
    accessToken: string,
    query: string,
    maxResults: number,
    pageToken?: string
  ): Promise<GmailMessagesListResponse> {
    const params = new URLSearchParams({
      q: query,
      maxResults: String(maxResults),
    })
    if (pageToken) params.set("pageToken", pageToken)

    const res = await fetch(`${GMAIL_BASE}/messages?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    return readGmailJson<GmailMessagesListResponse>(res, "list")
  }

  async getMessage(accessToken: string, messageId: string): Promise<GmailMessageResource> {
    const params = new URLSearchParams({ format: "full" })
    const res = await fetch(`${GMAIL_BASE}/messages/${messageId}?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) {
      throw mapHttpStatusToGmailError(res.status, "message", messageId)
    }
    return (await res.json()) as GmailMessageResource
  }

  async getAttachment(
    accessToken: string,
    messageId: string,
    attachmentId: string
  ): Promise<GmailAttachmentResource> {
    const res = await fetch(
      `${GMAIL_BASE}/messages/${messageId}/attachments/${attachmentId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    )
    if (!res.ok) {
      throw mapHttpStatusToGmailError(res.status, "message", messageId)
    }
    return (await res.json()) as GmailAttachmentResource
  }
}

export function isGmailProviderError(error: unknown): error is GmailProviderError {
  return error instanceof GmailProviderError
}
