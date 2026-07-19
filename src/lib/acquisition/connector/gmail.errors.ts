export type GmailErrorCode =
  | "GMAIL_NOT_CONNECTED"
  | "GMAIL_TOKEN_REFRESH_FAILED"
  | "GMAIL_UNAUTHORIZED"
  | "GMAIL_RATE_LIMITED"
  | "GMAIL_HISTORY_EXPIRED"
  | "GMAIL_UNAVAILABLE"
  | "GMAIL_MESSAGE_NOT_FOUND"
  | "GMAIL_MESSAGE_PARSE_ERROR"

export class GmailProviderError extends Error {
  readonly code: GmailErrorCode
  readonly retryable: boolean
  readonly global: boolean
  readonly messageId?: string

  constructor(options: {
    code: GmailErrorCode
    message: string
    retryable: boolean
    global: boolean
    messageId?: string
  }) {
    super(options.message)
    this.name = "GmailProviderError"
    this.code = options.code
    this.retryable = options.retryable
    this.global = options.global
    this.messageId = options.messageId
  }
}

export function mapHttpStatusToGmailError(
  status: number,
  context: "list" | "history" | "message" | "profile" | "token",
  messageId?: string
): GmailProviderError {
  if (status === 404 && context === "message") {
    return new GmailProviderError({
      code: "GMAIL_MESSAGE_NOT_FOUND",
      message: "Message Gmail introuvable",
      retryable: false,
      global: false,
      messageId,
    })
  }
  if (status === 401 || status === 403) {
    return new GmailProviderError({
      code: "GMAIL_UNAUTHORIZED",
      message: `Gmail API unauthorized (${context})`,
      retryable: false,
      global: true,
    })
  }
  if (status === 429) {
    return new GmailProviderError({
      code: "GMAIL_RATE_LIMITED",
      message: "Gmail API rate limit exceeded",
      retryable: true,
      global: true,
    })
  }
  if (status === 404 && context === "history") {
    return new GmailProviderError({
      code: "GMAIL_HISTORY_EXPIRED",
      message: "Gmail historyId expired or invalid",
      retryable: true,
      global: true,
    })
  }
  if (status >= 500) {
    return new GmailProviderError({
      code: "GMAIL_UNAVAILABLE",
      message: `Gmail API unavailable (${status})`,
      retryable: true,
      global: true,
    })
  }
  return new GmailProviderError({
    code: "GMAIL_UNAVAILABLE",
    message: `Gmail API error ${status} (${context})`,
    retryable: status >= 500,
    global: true,
  })
}
