/**
 * PLAN-ACQ-V2 Lot H — Liste messages d’un thread Gmail (métadonnées).
 */

import type { GmailApiClient } from "@/lib/acquisition/connector/gmail-api.client"
import { FetchGmailApiClient } from "@/lib/acquisition/connector/gmail-api.client"
import type { AcquisitionGmailConnectionClient } from "@/lib/acquisition/connector/acquisition-gmail-connection.client"
import { PrismaAcquisitionGmailConnectionClient } from "@/lib/acquisition/connector/acquisition-gmail-connection.client"

export type GmailThreadMessageSummary = {
  id: string
  threadId: string | null
  snippet: string | null
  internalDate: string | null
}

export async function listGmailThreadMessages(input: {
  companyId: string
  threadId: string
  connectionId: string
  connectionClient?: AcquisitionGmailConnectionClient
  apiClient?: GmailApiClient
}): Promise<GmailThreadMessageSummary[]> {
  if (!input.connectionId) throw new Error("connectionId requis")
  const connection = input.connectionClient ?? new PrismaAcquisitionGmailConnectionClient()
  const api = input.apiClient ?? new FetchGmailApiClient()
  const token = await connection.getValidAccessToken({
    companyId: input.companyId,
    connectionId: input.connectionId,
  })

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
