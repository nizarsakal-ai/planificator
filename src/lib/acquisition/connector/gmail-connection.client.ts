import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { decrypt, encrypt } from "@/lib/encryption"
import type { GmailTokenRefreshResponse } from "@/lib/acquisition/connector/gmail-api.types"
import { GmailProviderError } from "@/lib/acquisition/connector/gmail.errors"

const TOKEN_REFRESH_URL = "https://oauth2.googleapis.com/token"
const EXPIRY_MARGIN_MS = 5 * 60 * 1000

type AcquisitionGmailConnectionDiagStage =
  | "CONNECTION_LOOKUP"
  | "ACCESS_TOKEN_DECRYPT"
  | "REFRESH_TOKEN_DECRYPT"
  | "TOKEN_REFRESH_REQUEST"
  | "TOKEN_REFRESH_PARSE"
  | "TOKEN_PERSIST"

/**
 * Diagnostic temporaire (PLAN-ACQ-GMAIL-ROOTCAUSE-001).
 * Flag OFF => no-op. Ne loggue que le stage qui a throw. Aucun secret/message/stack.
 */
function logAcquisitionGmailConnectionDiag(stage: AcquisitionGmailConnectionDiagStage): void {
  try {
    if (process.env.ACQUISITION_GMAIL_DIAGNOSTIC !== "true") return
    console.info(`[acquisition-gmail-connection-diag] ${JSON.stringify({ stage })}`)
  } catch {
    // Le diagnostic ne doit jamais provoquer une nouvelle exception.
  }
}

export interface GmailConnectionClient {
  getValidAccessToken(companyId: string): Promise<string>
}

/** Accès OAuth Gmail par tenant — réutilise gmail_connections existant. */
export class PrismaGmailConnectionClient implements GmailConnectionClient {
  constructor(private readonly db: PrismaClient = prisma) {}

  async getValidAccessToken(companyId: string): Promise<string> {
    if (!companyId) throw new Error("companyId requis")

    let conn
    try {
      conn = await this.db.gmailConnection.findUnique({ where: { companyId } })
    } catch (error) {
      logAcquisitionGmailConnectionDiag("CONNECTION_LOOKUP")
      throw error
    }

    if (!conn) {
      throw new GmailProviderError({
        code: "GMAIL_NOT_CONNECTED",
        message: "Aucune connexion Gmail active pour cette entreprise",
        retryable: false,
        global: true,
      })
    }

    let accessToken: string
    try {
      accessToken = decrypt(conn.accessToken)
    } catch (error) {
      logAcquisitionGmailConnectionDiag("ACCESS_TOKEN_DECRYPT")
      throw error
    }

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
      logAcquisitionGmailConnectionDiag("REFRESH_TOKEN_DECRYPT")
      throw new GmailProviderError({
        code: "GMAIL_TOKEN_REFRESH_FAILED",
        message: "Impossible de déchiffrer le refresh token",
        retryable: false,
        global: true,
      })
    }

    let refreshRes: Response
    try {
      refreshRes = await fetch(TOKEN_REFRESH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
      })
    } catch (error) {
      logAcquisitionGmailConnectionDiag("TOKEN_REFRESH_REQUEST")
      throw error
    }

    let refreshData: GmailTokenRefreshResponse
    try {
      refreshData = (await refreshRes.json()) as GmailTokenRefreshResponse
    } catch (error) {
      logAcquisitionGmailConnectionDiag("TOKEN_REFRESH_PARSE")
      throw error
    }

    if (!refreshRes.ok || !refreshData.access_token) {
      throw new GmailProviderError({
        code: "GMAIL_TOKEN_REFRESH_FAILED",
        message: refreshData.error_description ?? refreshData.error ?? "Échec du refresh token",
        retryable: refreshRes.status >= 500 || refreshRes.status === 429,
        global: true,
      })
    }

    accessToken = refreshData.access_token
    try {
      await this.db.gmailConnection.update({
        where: { companyId },
        data: {
          accessToken: encrypt(refreshData.access_token),
          tokenExpiry: new Date(Date.now() + (refreshData.expires_in ?? 3600) * 1000),
        },
      })
    } catch (error) {
      logAcquisitionGmailConnectionDiag("TOKEN_PERSIST")
      throw error
    }

    return accessToken
  }
}
