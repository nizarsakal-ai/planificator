/**
 * Récupération contrôlée du corps Gmail pour enrichissement Booking.
 * Isolé companyId — ne journalise jamais le corps ni les tokens.
 */

import { prisma } from "@/lib/prisma"
import { decrypt, encrypt } from "@/lib/encryption"
import { decodeHtmlEntities, htmlToPlainText } from "@/lib/text/html-to-plain-text"
import { truncateBookingEmailForExtract } from "@/lib/booking/booking-pending-merge"

const TOKEN_REFRESH_URL = "https://oauth2.googleapis.com/token"
const EXPIRY_MARGIN_MS = 5 * 60 * 1000

type GmailPayloadPart = {
  mimeType?: string
  body?: { data?: string }
  parts?: GmailPayloadPart[]
}

export type BookingGmailBodySourceMime =
  | "text/plain"
  | "text/html"
  | "multipart"
  | "none"

export type NormalizedBookingGmailBody = {
  text: string
  sourceMime: BookingGmailBodySourceMime
}

export type BookingGmailBodyResult =
  | { ok: true; text: string }
  | { ok: false; code: string; retryable: boolean; message: string }

function extractTextFromParts(
  parts: GmailPayloadPart[] | undefined
): { text: string; sources: Set<"text/plain" | "text/html">; chunks: number } {
  let text = ""
  const sources = new Set<"text/plain" | "text/html">()
  let chunks = 0
  for (const part of parts ?? []) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      const chunk = decodeHtmlEntities(
        Buffer.from(part.body.data, "base64url").toString("utf8")
      )
      text += chunk
      // Plain vide / blanc : n’est pas un contributeur MIME (html peut prendre le relais).
      if (chunk.trim()) {
        sources.add("text/plain")
        chunks++
      }
    } else if (part.mimeType === "text/html" && part.body?.data && !text) {
      const html = Buffer.from(part.body.data, "base64url").toString("utf8")
      const chunk = htmlToPlainText(html)
      text += chunk
      if (chunk.trim()) {
        sources.add("text/html")
        chunks++
      }
    } else if (part.parts) {
      const nested = extractTextFromParts(part.parts)
      text += nested.text
      nested.sources.forEach((source) => sources.add(source))
      chunks += nested.chunks
    }
  }
  return { text, sources, chunks }
}

export function extractNormalizedGmailBodyWithMetadata(
  payload: GmailPayloadPart | undefined
): NormalizedBookingGmailBody {
  if (!payload) return { text: "", sourceMime: "none" }
  if (payload.parts) {
    const extracted = extractTextFromParts(payload.parts)
    const sourceMime: BookingGmailBodySourceMime =
      extracted.chunks > 1 || extracted.sources.size > 1
        ? "multipart"
        : (extracted.sources.values().next().value ?? "none")
    return { text: extracted.text.trim(), sourceMime }
  }
  if (payload.body?.data) {
    const raw = Buffer.from(payload.body.data, "base64url").toString("utf8")
    if (payload.mimeType === "text/html") {
      return { text: htmlToPlainText(raw), sourceMime: "text/html" }
    }
    // text/plain : décoder les entités résiduelles (&nbsp; littéral) sans strip HTML.
    return {
      text: decodeHtmlEntities(raw).trim(),
      sourceMime: "text/plain",
    }
  }
  return { text: "", sourceMime: "none" }
}

export function extractNormalizedGmailBody(
  payload: GmailPayloadPart | undefined
): string {
  return extractNormalizedGmailBodyWithMetadata(payload).text
}

async function getCompanyAccessToken(companyId: string): Promise<string> {
  const conn = await prisma.gmailConnection.findUnique({ where: { companyId } })
  if (!conn) {
    throw Object.assign(new Error("GMAIL_NOT_CONNECTED"), {
      code: "GMAIL_NOT_CONNECTED",
      retryable: false,
    })
  }

  let accessToken = decrypt(conn.accessToken)
  const expirySoon = conn.tokenExpiry.getTime() < Date.now() + EXPIRY_MARGIN_MS
  if (!expirySoon) return accessToken

  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw Object.assign(new Error("GMAIL_TOKEN_REFRESH_FAILED"), {
      code: "GMAIL_TOKEN_REFRESH_FAILED",
      retryable: false,
    })
  }

  const refreshToken = decrypt(conn.refreshToken)
  const refreshRes = await fetch(TOKEN_REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  })
  const refreshData = (await refreshRes.json()) as {
    access_token?: string
    expires_in?: number
    error?: string
  }
  if (!refreshRes.ok || !refreshData.access_token) {
    throw Object.assign(new Error("GMAIL_TOKEN_REFRESH_FAILED"), {
      code: "GMAIL_TOKEN_REFRESH_FAILED",
      retryable: refreshRes.status >= 500 || refreshRes.status === 429,
    })
  }

  accessToken = refreshData.access_token
  await prisma.gmailConnection.update({
    where: { companyId },
    data: {
      accessToken: encrypt(accessToken),
      tokenExpiry: new Date(Date.now() + (refreshData.expires_in ?? 3600) * 1000),
    },
  })
  return accessToken
}

/**
 * Charge et normalise le corps d’un message Gmail pour un tenant donné.
 * `fetchImpl` / `getAccessToken` injectables pour tests (pas de réseau).
 */
export async function fetchBookingGmailMessageBody(
  companyId: string,
  gmailMessageId: string,
  deps: {
    fetchImpl?: typeof fetch
    getAccessToken?: (companyId: string) => Promise<string>
  } = {}
): Promise<BookingGmailBodyResult> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const getAccessToken = deps.getAccessToken ?? getCompanyAccessToken

  if (!companyId || !gmailMessageId) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      retryable: false,
      message: "companyId et gmailMessageId requis",
    }
  }

  try {
    const accessToken = await getAccessToken(companyId)
    const msgRes = await fetchImpl(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(gmailMessageId)}?format=full`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    )
    if (!msgRes.ok) {
      return {
        ok: false,
        code: "GMAIL_TEMPORARY",
        retryable: msgRes.status >= 500 || msgRes.status === 429,
        message: `Gmail get HTTP ${msgRes.status}`,
      }
    }
    const msgData = (await msgRes.json()) as { payload?: GmailPayloadPart; snippet?: string }
    const body = extractNormalizedGmailBody(msgData.payload)
    const text = truncateBookingEmailForExtract(
      (body || msgData.snippet || "").trim()
    )
    if (!text) {
      return {
        ok: false,
        code: "EMPTY_MESSAGE_BODY",
        retryable: false,
        message: "Corps et snippet vides",
      }
    }
    return { ok: true, text }
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: string }).code)
        : "GMAIL_TEMPORARY"
    const retryable =
      err && typeof err === "object" && "retryable" in err
        ? Boolean((err as { retryable: boolean }).retryable)
        : true
    return {
      ok: false,
      code,
      retryable,
      message: "Échec récupération Gmail",
    }
  }
}
