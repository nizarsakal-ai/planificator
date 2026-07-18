import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"

export interface GmailConnectionListingPort {
  /** Tenants possédant une ligne gmail_connections (V1 — pas de filtre tokenExpiry). */
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
