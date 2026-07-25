/**
 * Classification d'erreurs Booking Gmail.
 * Ne stocke jamais le corps d'email ni de secrets.
 */

export type BookingErrorKind = "RETRYABLE" | "PERMANENT"

export interface ClassifiedBookingError {
  kind: BookingErrorKind
  code: string
  /** Message court, sans PII / corps email. */
  message: string
}

const MAX_ERROR_MESSAGE_LEN = 240

export function sanitizeBookingErrorMessage(raw: string): string {
  const cleaned = raw
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/ya29\.[A-Za-z0-9_-]+/g, "[redacted-token]")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted-key]")
    .replace(/\s+/g, " ")
    .trim()
  return cleaned.slice(0, MAX_ERROR_MESSAGE_LEN)
}

export function classifyBookingError(error: unknown): ClassifiedBookingError {
  if (isClassifiedBookingError(error)) return error

  const name = error instanceof Error ? error.name : ""
  const msg = error instanceof Error ? error.message : String(error)
  const lower = msg.toLowerCase()

  if (msg === "EMPTY_MESSAGE_BODY" || name === "EMPTY_MESSAGE_BODY") {
    return { kind: "PERMANENT", code: "EMPTY_MESSAGE_BODY", message: "Corps et snippet vides" }
  }
  if (msg === "NO_USEFUL_BOOKING_DATA" || name === "NO_USEFUL_BOOKING_DATA") {
    return {
      kind: "PERMANENT",
      code: "NO_USEFUL_BOOKING_DATA",
      message: "Aucune donnée Booking utile après parsing",
    }
  }
  if (msg === "BEFORE_CUTOFF_DATE" || name === "BEFORE_CUTOFF_DATE") {
    return {
      kind: "PERMANENT",
      code: "BEFORE_CUTOFF_DATE",
      message: "Date d'arrivée antérieure à la règle métier documentée",
    }
  }

  if (
    lower.includes("fetch failed") ||
    lower.includes("network") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("timeout") ||
    lower.includes("429") ||
    lower.includes("503") ||
    lower.includes("502") ||
    lower.includes("504")
  ) {
    return {
      kind: "RETRYABLE",
      code: "TRANSIENT_NETWORK",
      message: sanitizeBookingErrorMessage(msg),
    }
  }

  if (lower.includes("anthropic") || lower.includes("overloaded") || lower.includes("rate_limit")) {
    return {
      kind: "RETRYABLE",
      code: "PROVIDER_TEMPORARY",
      message: sanitizeBookingErrorMessage(msg),
    }
  }

  if (
    name === "PrismaClientKnownRequestError" ||
    lower.includes("can't reach database") ||
    lower.includes("connection pool") ||
    lower.includes("p1001") ||
    lower.includes("p1002") ||
    lower.includes("p1017")
  ) {
    return {
      kind: "RETRYABLE",
      code: "DATABASE_TEMPORARY",
      message: sanitizeBookingErrorMessage(msg),
    }
  }

  if (lower.includes("gmail") && (lower.includes("500") || lower.includes("503"))) {
    return {
      kind: "RETRYABLE",
      code: "GMAIL_TEMPORARY",
      message: sanitizeBookingErrorMessage(msg),
    }
  }

  return {
    kind: "RETRYABLE",
    code: "UNKNOWN_RETRYABLE",
    message: sanitizeBookingErrorMessage(msg || "Erreur inconnue"),
  }
}

export function isClassifiedBookingError(value: unknown): value is ClassifiedBookingError {
  if (!value || typeof value !== "object") return false
  const v = value as ClassifiedBookingError
  return (
    (v.kind === "RETRYABLE" || v.kind === "PERMANENT") &&
    typeof v.code === "string" &&
    typeof v.message === "string"
  )
}

export function permanentBookingError(code: string, message: string): ClassifiedBookingError {
  return { kind: "PERMANENT", code, message: sanitizeBookingErrorMessage(message) }
}

export function retryableBookingError(code: string, message: string): ClassifiedBookingError {
  return { kind: "RETRYABLE", code, message: sanitizeBookingErrorMessage(message) }
}
