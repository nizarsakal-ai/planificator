/**
 * PLAN-ACQ-V2 Lot H — Liste messages d’un thread Gmail (métadonnées).
 */

import type { GmailApiClient } from "@/lib/acquisition/connector/gmail-api.client"
import { FetchGmailApiClient } from "@/lib/acquisition/connector/gmail-api.client"
import type { GmailConnectionClient } from "@/lib/acquisition/connector/gmail-connection.client"
import { PrismaGmailConnectionClient } from "@/lib/acquisition/connector/gmail-connection.client"

export type GmailThreadMessageSummary = {
  id: string
  threadId: string | null
  snippet: string | null
  internalDate: string | null
}

export async function listGmailThreadMessages(input: {
  companyId: string
  threadId: string
  connectionClient?: GmailConnectionClient
  apiClient?: GmailApiClient
}): Promise<GmailThreadMessageSummary[]> {
  const connection = input.connectionClient ?? new PrismaGmailConnectionClient()
  const api = input.apiClient ?? new FetchGmailApiClient()
  const token = await connection.getValidAccessToken(input.companyId)

  // Query Gmail : messages du même thread.
  const list = await api.listMessages(
    token,
    `thread:${input.threadId}`,
    50,
    undefined
  )
  const ids = (list.messages ?? []).map((m) => m.id)
  const out: GmailThreadMessageSummary[] = []
  for (const id of ids) {
    try {
      const msg = await api.getMessage(token, id)
      out.push({
        id: msg.id,
        threadId: msg.threadId ?? input.threadId,
        snippet: msg.snippet ?? null,
        internalDate: msg.internalDate ?? null,
      })
    } catch {
      continue
    }
  }
  return out
}
