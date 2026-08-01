/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1C
 * Gate-0 redaction — API pure pour logs Integration mail-shadow.
 * Smoke = tests/CI uniquement (jamais runtime).
 */

const TOKENISH =
  /(?:Bearer\s+)\S+|ya29\.[A-Za-z0-9_-]+|sk-ant-[A-Za-z0-9_-]+|AIza[0-9A-Za-z_-]{20,}|(?:access_token|refresh_token|id_token|token)\s*[:=]\s*[^\s&]+/gi

const SENSITIVE_QUERY =
  /([?&](?:access_token|refresh_token|id_token|token|signature|Signature)=)[^&\s]*/gi

const AUTHORIZATION_HEADER = /(Authorization\s*[:=]\s*)[^\s,;]+/gi

const COOKIEISH = /(Cookie\s*[:=]\s*)[^\n;]+/gi

const LONG_BASE64ISH = /\b[A-Za-z0-9+/]{80,}={0,2}\b/g

/** Adresses email génériques dans une chaîne libre. */
const EMAIL_ADDRESS =
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g

export const REDACTED = "[REDACTED]" as const

/**
 * Champs jamais journalisés en clair (clés normalisées lower-case).
 * Couvre notamment : sender, senderEmail, sender_email, email,
 * emailAddress, from, replyTo (normalizeKey retire _ et casse).
 */
const FORBIDDEN_LOG_KEYS = new Set([
  "body",
  "bodytext",
  "html",
  "raw",
  "payload",
  "mime",
  "subject",
  "email",
  "emailaddress",
  "sender",
  "senderemail",
  "from",
  "replyto",
  "to",
  "authorization",
  "accesstoken",
  "refreshtoken",
  "password",
  "cookie",
  "secret",
  "stack",
  "providerstack",
])

export function redactString(value: string): string {
  return value
    .replace(TOKENISH, REDACTED)
    .replace(SENSITIVE_QUERY, `$1${REDACTED}`)
    .replace(AUTHORIZATION_HEADER, `$1${REDACTED}`)
    .replace(COOKIEISH, `$1${REDACTED}`)
    .replace(LONG_BASE64ISH, REDACTED)
    .replace(EMAIL_ADDRESS, REDACTED)
}

function normalizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactString(value)
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item))
  }
  if (typeof value === "object") {
    return redactLogFields(value as Record<string, unknown>)
  }
  return REDACTED
}

/**
 * Redacte un objet de log (plat ou imbriqué). Clés interdites → REDACTED.
 * Valeurs string passent par redactString (tokens, emails, etc.).
 */
export function redactLogFields(
  fields: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    const nk = normalizeKey(key)
    if (FORBIDDEN_LOG_KEYS.has(nk) || nk.includes("token") || nk.includes("secret")) {
      out[key] = REDACTED
      continue
    }
    out[key] = redactValue(value)
  }
  return out
}

/** Message d’erreur générique sans stack provider / payload. */
export function redactError(error: unknown): { message: string; name?: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactString(error.message.slice(0, 200)),
    }
  }
  if (typeof error === "string") {
    return { message: redactString(error.slice(0, 200)) }
  }
  return { message: "unknown_error" }
}
