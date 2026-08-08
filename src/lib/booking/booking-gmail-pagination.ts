/**
 * PLAN-BOOKING-FINAL LOT 2C — List Gmail progressive (messages.list uniquement).
 * Aucun Prisma / lifecycle / extract / persist.
 */

export const BOOKING_GMAIL_LIST_QUERY = "from:noreply@booking.com"

export const BOOKING_GMAIL_LIST_PAGE_SIZE_DEFAULT = 50
export const BOOKING_GMAIL_LIST_PAGE_SIZE_MIN = 1
export const BOOKING_GMAIL_LIST_PAGE_SIZE_MAX = 100

export const BOOKING_GMAIL_MAX_PAGES_PER_CONNECTION_DEFAULT = 10
export const BOOKING_GMAIL_MAX_PAGES_PER_CONNECTION_MIN = 1
export const BOOKING_GMAIL_MAX_PAGES_PER_CONNECTION_MAX = 40

export const BOOKING_GMAIL_MAX_FULL_FETCHES_PER_CONNECTION_DEFAULT = 25
export const BOOKING_GMAIL_MAX_FULL_FETCHES_PER_CONNECTION_MIN = 1
export const BOOKING_GMAIL_MAX_FULL_FETCHES_PER_CONNECTION_MAX = 100

export const BOOKING_GMAIL_MAX_FULL_FETCHES_PER_RUN_DEFAULT = 40
export const BOOKING_GMAIL_MAX_FULL_FETCHES_PER_RUN_MIN = 1
export const BOOKING_GMAIL_MAX_FULL_FETCHES_PER_RUN_MAX = 150

const GMAIL_LIST_BASE =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages"

function parseBoundedPositiveInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (raw === undefined) return fallback
  const trimmed = raw.trim()
  if (!trimmed) return fallback
  const n = Number(trimmed)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    return fallback
  }
  return n
}

export function getBookingGmailListPageSize(
  env: NodeJS.ProcessEnv = process.env
): number {
  return parseBoundedPositiveInt(
    env.BOOKING_GMAIL_LIST_PAGE_SIZE,
    BOOKING_GMAIL_LIST_PAGE_SIZE_DEFAULT,
    BOOKING_GMAIL_LIST_PAGE_SIZE_MIN,
    BOOKING_GMAIL_LIST_PAGE_SIZE_MAX
  )
}

export function getBookingGmailMaxPagesPerConnection(
  env: NodeJS.ProcessEnv = process.env
): number {
  return parseBoundedPositiveInt(
    env.BOOKING_GMAIL_MAX_PAGES_PER_CONNECTION,
    BOOKING_GMAIL_MAX_PAGES_PER_CONNECTION_DEFAULT,
    BOOKING_GMAIL_MAX_PAGES_PER_CONNECTION_MIN,
    BOOKING_GMAIL_MAX_PAGES_PER_CONNECTION_MAX
  )
}

export function getBookingGmailMaxFullFetchesPerConnection(
  env: NodeJS.ProcessEnv = process.env
): number {
  return parseBoundedPositiveInt(
    env.BOOKING_GMAIL_MAX_FULL_FETCHES_PER_CONNECTION,
    BOOKING_GMAIL_MAX_FULL_FETCHES_PER_CONNECTION_DEFAULT,
    BOOKING_GMAIL_MAX_FULL_FETCHES_PER_CONNECTION_MIN,
    BOOKING_GMAIL_MAX_FULL_FETCHES_PER_CONNECTION_MAX
  )
}

export function getBookingGmailMaxFullFetchesPerRun(
  env: NodeJS.ProcessEnv = process.env
): number {
  return parseBoundedPositiveInt(
    env.BOOKING_GMAIL_MAX_FULL_FETCHES_PER_RUN,
    BOOKING_GMAIL_MAX_FULL_FETCHES_PER_RUN_DEFAULT,
    BOOKING_GMAIL_MAX_FULL_FETCHES_PER_RUN_MIN,
    BOOKING_GMAIL_MAX_FULL_FETCHES_PER_RUN_MAX
  )
}

export type BookingGmailFullFetchBudget = {
  connectionRemaining: number
  globalRemaining: number
}

/** Budget full-fetch disponible pour un claim éventuel. */
export function canAdmitFullFetch(budget: BookingGmailFullFetchBudget): boolean {
  return budget.connectionRemaining > 0 && budget.globalRemaining > 0
}

/** Consomme 1 unité connexion + 1 unité globale (après CLAIMED). */
export function consumeFullFetchAdmission(
  budget: BookingGmailFullFetchBudget
): BookingGmailFullFetchBudget {
  return {
    connectionRemaining: budget.connectionRemaining - 1,
    globalRemaining: budget.globalRemaining - 1,
  }
}

export type BookingGmailMessagePage = {
  messageIds: string[]
  pageIndex: number
  /** True ssi un nextPageToken est présent et une page suivante pourrait être demandée. */
  hasNextPageToken: boolean
  stopHint:
    | "continue"
    | "exhausted"
    | "max_pages"
    | "token_repeat"
    | "no_new_ids"
}

export type BookingGmailListErrorKind = "http" | "invalid_json"

/** Champs Google error extraits de manière sûre (jamais le body complet). */
export type BookingGmailListGoogleErrorDetails = {
  googleErrorCode?: number
  googleErrorStatus?: string
  googleErrorMessage?: string
}

export class BookingGmailListError extends Error {
  readonly kind: BookingGmailListErrorKind
  readonly httpStatus: number | undefined
  readonly googleErrorCode: number | undefined
  readonly googleErrorStatus: string | undefined
  readonly googleErrorMessage: string | undefined

  constructor(
    kind: BookingGmailListErrorKind,
    httpStatus?: number,
    details?: BookingGmailListGoogleErrorDetails
  ) {
    super(
      kind === "http"
        ? `Gmail list HTTP ${httpStatus ?? "?"}`
        : "Gmail list invalid JSON"
    )
    this.name = "BookingGmailListError"
    this.kind = kind
    this.httpStatus = httpStatus
    this.googleErrorCode = details?.googleErrorCode
    this.googleErrorStatus = details?.googleErrorStatus
    this.googleErrorMessage = details?.googleErrorMessage
  }
}

/** Borne max pour googleErrorMessage (évite logs anormalement longs). */
export const BOOKING_GMAIL_GOOGLE_ERROR_MESSAGE_MAX = 500

const GOOGLE_ERROR_EMAIL_RE =
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g

/**
 * Durcit error.message avant conservation / log :
 * - masque les emails → [REDACTED_EMAIL]
 * - tronque à BOOKING_GMAIL_GOOGLE_ERROR_MESSAGE_MAX
 */
export function sanitizeGoogleListErrorMessage(raw: string): string {
  const redacted = raw.replace(GOOGLE_ERROR_EMAIL_RE, "[REDACTED_EMAIL]")
  if (redacted.length <= BOOKING_GMAIL_GOOGLE_ERROR_MESSAGE_MAX) return redacted
  return redacted.slice(0, BOOKING_GMAIL_GOOGLE_ERROR_MESSAGE_MAX)
}

/**
 * Extrait uniquement error.code / error.status / error.message si présents et typés.
 * Body non-JSON, JSON invalide ou format inattendu → objet vide (fallback httpStatus seul).
 * googleErrorMessage est toujours sanitisé (email + borne 500).
 */
export async function readSafeGoogleListErrorDetails(
  res: Response
): Promise<BookingGmailListGoogleErrorDetails> {
  let raw: unknown
  try {
    raw = await res.json()
  } catch {
    return {}
  }
  if (typeof raw !== "object" || raw === null) return {}
  const error = (raw as { error?: unknown }).error
  if (typeof error !== "object" || error === null) return {}
  const record = error as {
    code?: unknown
    status?: unknown
    message?: unknown
  }
  const details: BookingGmailListGoogleErrorDetails = {}
  if (typeof record.code === "number" && Number.isFinite(record.code)) {
    details.googleErrorCode = record.code
  }
  if (typeof record.status === "string" && record.status.length > 0) {
    details.googleErrorStatus = record.status
  }
  if (typeof record.message === "string" && record.message.length > 0) {
    details.googleErrorMessage = sanitizeGoogleListErrorMessage(record.message)
  }
  return details
}

/** Ligne de log diagnostique — champs sûrs uniquement (pas de body / tokens). */
export function formatBookingGmailListErrorLog(
  err: BookingGmailListError,
  companyId: string
): string {
  const parts = [`[gmail-scan] Gmail list ${err.kind}`]
  if (err.httpStatus != null) parts.push(`httpStatus=${err.httpStatus}`)
  if (err.googleErrorCode != null) parts.push(`googleErrorCode=${err.googleErrorCode}`)
  if (err.googleErrorStatus != null) {
    parts.push(`googleErrorStatus=${err.googleErrorStatus}`)
  }
  if (err.googleErrorMessage != null) {
    parts.push(`googleErrorMessage=${err.googleErrorMessage}`)
  }
  parts.push(`for company ${companyId}`)
  return parts.join(" ")
}

export function buildBookingGmailListUrl(input: {
  pageSize: number
  pageToken?: string | null
  query?: string
}): string {
  const params = new URLSearchParams({
    q: input.query ?? BOOKING_GMAIL_LIST_QUERY,
    maxResults: String(input.pageSize),
  })
  if (input.pageToken) params.set("pageToken", input.pageToken)
  return `${GMAIL_LIST_BASE}?${params.toString()}`
}

function extractMessageIds(
  data: unknown,
  seenIds: Set<string>
): { newIds: string[]; nextPageToken: string | null } {
  if (typeof data !== "object" || data === null) {
    return { newIds: [], nextPageToken: null }
  }
  const record = data as { messages?: unknown; nextPageToken?: unknown }
  const nextPageToken =
    typeof record.nextPageToken === "string" && record.nextPageToken.length > 0
      ? record.nextPageToken
      : null

  const newIds: string[] = []
  if (!Array.isArray(record.messages)) {
    return { newIds, nextPageToken }
  }
  for (const entry of record.messages) {
    if (typeof entry !== "object" || entry === null) continue
    const id = (entry as { id?: unknown }).id
    if (typeof id !== "string") continue
    const trimmed = id.trim()
    if (!trimmed) continue
    if (seenIds.has(trimmed)) continue
    seenIds.add(trimmed)
    newIds.push(trimmed)
  }
  return { newIds, nextPageToken }
}

/**
 * Règle anti-boucle (déterministe) :
 * - pas de nextPageToken → fin normale (`exhausted`) ;
 * - token déjà vu avant fetch (répétition / cycle A→B→A) → stop (`token_repeat`) ;
 * - page sans aucun nouvel id (après dédup) alors qu’un token suivant existe → stop (`no_new_ids`)
 *   pour éviter de suivre des pages sans progression ;
 * - max pages atteint → `max_pages`.
 */
export async function* iterateBookingGmailMessagePages(input: {
  accessToken: string
  fetchImpl?: typeof fetch
  pageSize?: number
  maxPages?: number
  query?: string
  env?: NodeJS.ProcessEnv
}): AsyncGenerator<BookingGmailMessagePage, void, undefined> {
  const fetchImpl = input.fetchImpl ?? fetch
  const env = input.env ?? process.env
  const pageSize = input.pageSize ?? getBookingGmailListPageSize(env)
  const maxPages = input.maxPages ?? getBookingGmailMaxPagesPerConnection(env)
  const query = input.query ?? BOOKING_GMAIL_LIST_QUERY

  const seenTokens = new Set<string>()
  const seenIds = new Set<string>()
  let pageToken: string | null = null
  let pageIndex = 0

  while (pageIndex < maxPages) {
    if (pageToken !== null) {
      if (seenTokens.has(pageToken)) {
        return
      }
      seenTokens.add(pageToken)
    }

    const url = buildBookingGmailListUrl({ pageSize, pageToken, query })
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${input.accessToken}` },
    })
    if (!res.ok) {
      const googleDetails = await readSafeGoogleListErrorDetails(res)
      throw new BookingGmailListError("http", res.status, googleDetails)
    }

    let data: unknown
    try {
      data = await res.json()
    } catch {
      throw new BookingGmailListError("invalid_json")
    }

    const { newIds, nextPageToken } = extractMessageIds(data, seenIds)
    pageIndex += 1

    const atMaxPages = pageIndex >= maxPages
    let stopHint: BookingGmailMessagePage["stopHint"] = "continue"
    if (!nextPageToken) stopHint = "exhausted"
    else if (atMaxPages) stopHint = "max_pages"
    else if (newIds.length === 0) stopHint = "no_new_ids"

    yield {
      messageIds: newIds,
      pageIndex,
      hasNextPageToken: Boolean(nextPageToken),
      stopHint,
    }

    if (!nextPageToken || atMaxPages || newIds.length === 0) {
      return
    }
    pageToken = nextPageToken
  }
}

export type BookingGmailClaimLoopResult = {
  budget: BookingGmailFullFetchBudget
  skipped: number
  claimed: number
  idsExamined: number
  pagesFetched: number
  stopReason: "exhausted" | "budget"
}

/**
 * Consomme les pages : check budget → claim → SKIP (gratuit) ou CLAIMED (coûte 1).
 * N’appelle jamais claim si budget épuisé.
 */
export async function runBookingGmailClaimLoop(input: {
  pages: AsyncIterable<Pick<BookingGmailMessagePage, "messageIds" | "pageIndex">>
  budget: BookingGmailFullFetchBudget
  claim: (messageId: string) => Promise<"SKIP" | "CLAIMED">
  onClaimed: (messageId: string) => Promise<void>
}): Promise<BookingGmailClaimLoopResult> {
  let budget = input.budget
  let skipped = 0
  let claimed = 0
  let idsExamined = 0
  let pagesFetched = 0

  for await (const page of input.pages) {
    pagesFetched += 1
    for (const messageId of page.messageIds) {
      idsExamined += 1
      if (!canAdmitFullFetch(budget)) {
        return {
          budget,
          skipped,
          claimed,
          idsExamined,
          pagesFetched,
          stopReason: "budget",
        }
      }

      const action = await input.claim(messageId)
      if (action === "SKIP") {
        skipped += 1
        continue
      }

      budget = consumeFullFetchAdmission(budget)
      claimed += 1
      await input.onClaimed(messageId)

      if (!canAdmitFullFetch(budget)) {
        return {
          budget,
          skipped,
          claimed,
          idsExamined,
          pagesFetched,
          stopReason: "budget",
        }
      }
    }
  }

  return {
    budget,
    skipped,
    claimed,
    idsExamined,
    pagesFetched,
    stopReason: "exhausted",
  }
}
