export type GmailErrorCode =
  | "GMAIL_NOT_CONNECTED"
  | "GMAIL_TOKEN_REFRESH_FAILED"
  | "GMAIL_UNAUTHORIZED"
  | "GMAIL_RATE_LIMITED"
  | "GMAIL_HISTORY_EXPIRED"
  | "GMAIL_UNAVAILABLE"
  | "GMAIL_MESSAGE_NOT_FOUND"
  | "GMAIL_MESSAGE_PARSE_ERROR"
  | "NO_ACTIVE_PARTNER_IDENTITIES"
  | "LEGACY_MAILBOX_AMBIGUOUS"

/**
 * Diagnostic HTTP Gmail — champs structurés validés uniquement.
 * Jamais de corps brut, de message Google, d'en-tête ni de token.
 */
export interface GmailHttpDiagnostics {
  gmailHttpStatus: number
  /** error.errors[0].reason, à défaut ErrorInfo.reason (ex. insufficientPermissions, ACCESS_TOKEN_SCOPE_INSUFFICIENT). */
  gmailErrorReason: string | null
  /** error.status Google (ex. PERMISSION_DENIED, UNAUTHENTICATED). */
  gmailErrorCode: string | null
}

export class GmailProviderError extends Error {
  readonly code: GmailErrorCode
  readonly retryable: boolean
  readonly global: boolean
  readonly messageId?: string
  readonly diagnostics?: GmailHttpDiagnostics

  constructor(options: {
    code: GmailErrorCode
    message: string
    retryable: boolean
    global: boolean
    messageId?: string
    diagnostics?: GmailHttpDiagnostics
  }) {
    super(options.message)
    this.name = "GmailProviderError"
    this.code = options.code
    this.retryable = options.retryable
    this.global = options.global
    this.messageId = options.messageId
    this.diagnostics = options.diagnostics
  }
}

/** Sans "." ni "-" : exclut ya29.*, adresses, domaines et identifiants pointés. */
const REASON_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const GOOGLE_STATUS_RE = /^[A-Z][A-Z0-9_]{0,63}$/
export const MAX_ERROR_BODY_BYTES = 16_384

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function safeReason(value: unknown): string | null {
  return typeof value === "string" && REASON_RE.test(value) ? value : null
}

function safeHttpStatus(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : null
}

/**
 * Extrait reason/status du format d'erreur JSON Google
 * `{ error: { code, status, errors: [{ reason }], details: [{ "@type": "…ErrorInfo", reason }] } }`.
 * Toute forme inattendue → null (le corps n'est jamais renvoyé).
 */
export function extractGoogleErrorDiagnostics(httpStatus: number, body: unknown): GmailHttpDiagnostics {
  const diagnostics: GmailHttpDiagnostics = {
    gmailHttpStatus: httpStatus,
    gmailErrorReason: null,
    gmailErrorCode: null,
  }
  if (!isRecord(body) || !isRecord(body.error)) return diagnostics
  const error = body.error

  if (Array.isArray(error.errors)) {
    for (const item of error.errors) {
      const reason = isRecord(item) ? safeReason(item.reason) : null
      if (reason) {
        diagnostics.gmailErrorReason = reason
        break
      }
    }
  }
  if (!diagnostics.gmailErrorReason && Array.isArray(error.details)) {
    for (const detail of error.details) {
      if (
        isRecord(detail) &&
        typeof detail["@type"] === "string" &&
        detail["@type"].endsWith("google.rpc.ErrorInfo")
      ) {
        const reason = safeReason(detail.reason)
        if (reason) {
          diagnostics.gmailErrorReason = reason
          break
        }
      }
    }
  }
  if (typeof error.status === "string" && GOOGLE_STATUS_RE.test(error.status)) {
    diagnostics.gmailErrorCode = error.status
  }
  return diagnostics
}

/**
 * Lit au plus MAX_ERROR_BODY_BYTES octets du corps, via le reader du flux.
 * Content-Length > limite, corps absent, dépassement en cours de lecture ou erreur → null.
 * Un contenu partiel n'est jamais analysé ; le buffer n'est jamais journalisé.
 */
async function readBoundedErrorBody(res: Response): Promise<Uint8Array | null> {
  const declared = res.headers.get("content-length")
  if (declared !== null) {
    const length = Number(declared)
    if (Number.isFinite(length) && length > MAX_ERROR_BODY_BYTES) {
      await res.body?.cancel().catch(() => {})
      return null
    }
  }
  if (!res.body) return null

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_ERROR_BODY_BYTES) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
  } catch {
    await reader.cancel().catch(() => {})
    return null
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** Diagnostic d'une réponse en erreur. Ne lève jamais ; n'affecte pas l'erreur Gmail fonctionnelle. */
export async function readGoogleErrorDiagnostics(res: Response): Promise<GmailHttpDiagnostics> {
  let body: unknown = null
  try {
    const bytes = await readBoundedErrorBody(res)
    if (bytes) body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    body = null
  }
  return extractGoogleErrorDiagnostics(res.status, body)
}

/** Revalide une valeur de diagnostic quelconque avant journalisation ; forme inattendue → undefined. */
export function sanitizeGmailDiagnostics(value: unknown): GmailHttpDiagnostics | undefined {
  if (!isRecord(value)) return undefined
  const status = safeHttpStatus(value.gmailHttpStatus)
  if (status === null) return undefined
  const code = value.gmailErrorCode
  return {
    gmailHttpStatus: status,
    gmailErrorReason: safeReason(value.gmailErrorReason),
    gmailErrorCode: typeof code === "string" && GOOGLE_STATUS_RE.test(code) ? code : null,
  }
}

/** Diagnostic revalidé, uniquement depuis une GmailProviderError. */
export function safeGmailDiagnostics(error: unknown): GmailHttpDiagnostics | undefined {
  if (!(error instanceof GmailProviderError)) return undefined
  return sanitizeGmailDiagnostics(error.diagnostics)
}

export function mapHttpStatusToGmailError(
  status: number,
  context: "list" | "history" | "message" | "profile" | "token",
  messageId?: string,
  diagnostics?: GmailHttpDiagnostics
): GmailProviderError {
  const error = mapHttpStatusToGmailErrorCore(status, context, messageId)
  return diagnostics
    ? new GmailProviderError({
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        global: error.global,
        messageId: error.messageId,
        diagnostics,
      })
    : error
}

function mapHttpStatusToGmailErrorCore(
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
