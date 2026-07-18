/** Types minimaux des réponses Gmail API v1 (lecture seule). */

export interface GmailHeader {
  name: string
  value: string
}

export interface GmailMessagePartBody {
  attachmentId?: string
  size?: number
  data?: string
}

export interface GmailMessagePart {
  partId?: string
  mimeType?: string
  filename?: string
  headers?: GmailHeader[]
  body?: GmailMessagePartBody
  parts?: GmailMessagePart[]
}

export interface GmailMessagePayload {
  partId?: string
  mimeType?: string
  filename?: string
  headers?: GmailHeader[]
  body?: GmailMessagePartBody
  parts?: GmailMessagePart[]
}

export interface GmailMessageResource {
  id: string
  threadId?: string
  labelIds?: string[]
  snippet?: string
  internalDate?: string
  payload?: GmailMessagePayload
  historyId?: string
}

export interface GmailMessagesListResponse {
  messages?: { id: string; threadId?: string }[]
  nextPageToken?: string
  resultSizeEstimate?: number
}

export interface GmailHistoryRecord {
  id?: string
  messagesAdded?: { message: { id: string; threadId?: string } }[]
}

export interface GmailHistoryListResponse {
  history?: GmailHistoryRecord[]
  historyId?: string
  nextPageToken?: string
}

export interface GmailProfileResponse {
  emailAddress?: string
  historyId?: string
}

export interface GmailTokenRefreshResponse {
  access_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

export interface GmailAttachmentResource {
  size?: number
  data?: string
}
