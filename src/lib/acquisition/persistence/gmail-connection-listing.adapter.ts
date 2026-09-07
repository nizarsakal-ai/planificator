import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"

export interface GmailConnectionListingPort {
  /**
   * @deprecated PLAN-ACQ-MULTI-GMAIL-001 — Acquisition lit acquisition_gmail_connections.
   * Conservé pour tests legacy / audit ; ne pas brancher le pipeline Acquisition.
   */
  listCompanyIdsWithGmailConnection(): Promise<string[]>
}

export class PrismaGmailConnectionListingAdapter implements GmailConnectionListingPort {
  constructor(private readonly db: PrismaClient = prisma) {}

  async listCompanyIdsWithGmailConnection(): Promise<string[]> {
    const connections = await this.db.gmailConnection.findMany({
      select: { companyId: true },
      orderBy: { companyId: "asc" },
    })
    return connections.map((c) => c.companyId)
  }
}

export const gmailConnectionListingAdapter = new PrismaGmailConnectionListingAdapter()
