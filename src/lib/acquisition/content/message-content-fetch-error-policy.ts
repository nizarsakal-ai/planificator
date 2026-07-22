import type { MessageContentErrorCode } from "@/lib/acquisition/content/message-content.types"

/** Classification OPS-003 — erreurs du chemin fetch content. */
export type ContentFetchErrorCategory =
  | "RETRYABLE"
  | "PERMANENT"
  | "CONFIG_TENANT"
  | "UI_ONLY"

export function classifyContentFetchError(code: MessageContentErrorCode): ContentFetchErrorCategory {
  switch (code) {
    case "GMAIL_RATE_LIMITED":
    case "GMAIL_UNAVAILABLE":
    case "CONTENT_FETCH_FAILED":
    case "CONTENT_PERSIST_FAILED":
      return "RETRYABLE"
    case "CONTENT_EMPTY":
    case "ACQUISITION_CONTENT_TOO_LARGE":
    case "GMAIL_MESSAGE_NOT_FOUND":
    case "GMAIL_MESSAGE_PARSE_ERROR":
    case "CONTENT_NOT_FOUND":
      return "PERMANENT"
    case "GMAIL_NOT_CONNECTED":
    case "GMAIL_TOKEN_REFRESH_FAILED":
    case "GMAIL_UNAUTHORIZED":
      return "CONFIG_TENANT"
    case "CONTENT_FETCH_DISABLED":
    case "CONTENT_UNAUTHORIZED":
    case "CONTENT_FORBIDDEN":
      return "UI_ONLY"
    default:
      return "RETRYABLE"
  }
}
