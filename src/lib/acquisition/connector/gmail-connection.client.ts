import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { decrypt, encrypt } from "@/lib/encryption"
import type { GmailTokenRefreshResponse } from "@/lib/acquisition/connector/gmail-api.types"
import { GmailProviderError } from "@/lib/acquisition/connector/gmail.errors"

const TOKEN_REFRESH_URL = "https://oauth2.googleapis.com/token"
const EXPIRY_MARGIN_MS = 5 * 60 * 1000

export interface GmailConnectionClient {
  getValidAccessToken(companyId: string): Promise<string>
}

/** Accès OAuth Gmail par tenant — réutilise gmail_connections existant. */
export class PrismaGmailConnectionClient implements GmailConnectionClient {
  constructor(private readonly db: PrismaClient = prisma) {}

  async getValidAccessToken(companyId: string): Promise<string> {
    if (!companyId) throw new Error("companyId requis")

    const conn = await this.db.gmailConnection.findUnique({ where: { companyId } })
    if (!conn) {
      throw new GmailProviderError({
        code: "GMAIL_NOT_CONNECTED",
        message: "Aucune connexion Gmail active pour cette entreprise",
        retryable: false,
        global: true,
      })
    }

    let accessToken = decrypt(conn.accessToken)
    const expirySoon = conn.tokenExpiry.getTime() < Date.now() + EXPIRY_MARGIN_MS

    if (!expirySoon) return accessToken

    const clientId = process.env.GOOGLE_CLIENT_ID
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET
    if (!clientId || !clientSecret) {
      throw new GmailProviderError({
        code: "GMAIL_TOKEN_REFRESH_FAILED",
        message: "Configuration OAuth Google incomplète",
        retryable: false,
        global: true,
      })
    }

    let refreshToken: string
    try {
      refreshToken = decrypt(conn.refreshToken)
    } catch {
      throw new GmailProviderError({
        code: "GMAIL_TOKEN_REFRESH_FAILED",
        message: "Impossible de déchiffrer le refresh token",
        retryable: false,
        global: true,
      })
    }

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

    const refreshData = (await refreshRes.json()) as GmailTokenRefreshResponse
    if (!refreshRes.ok || !refreshData.access_token) {
      throw new GmailProviderError({
        code: "GMAIL_TOKEN_REFRESH_FAILED",
        message: refreshData.error_description ?? refreshData.error ?? "Échec du refresh token",
        retryable: refreshRes.status >= 500 || refreshRes.status === 429,
        global: true,
      })
    }

    accessToken = refreshData.access_token
    await this.db.gmailConnection.update({
      where: { companyId },
      data: {
        accessToken: encrypt(refreshData.access_token),
        tokenExpiry: new Date(Date.now() + (refreshData.expires_in ?? 3600) * 1000),
      },
    })

    return accessToken
  }
}
