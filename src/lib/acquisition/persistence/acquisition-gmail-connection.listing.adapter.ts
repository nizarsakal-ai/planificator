import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"

/** Référence minimale d’une connexion Gmail Acquisition active. */
export interface AcquisitionGmailConnectionRef {
  connectionId: string
  companyId: string
  gmailAddress: string
}

export interface AcquisitionGmailConnectionListingPort {
  listActiveAcquisitionGmailConnections(): Promise<AcquisitionGmailConnectionRef[]>
}

/**
 * Listing multi-compte Acquisition — table acquisition_gmail_connections.
 * Ne lit jamais gmail_connections (Booking).
 */
export class PrismaAcquisitionGmailConnectionListingAdapter
  implements AcquisitionGmailConnectionListingPort
{
  constructor(private readonly db: PrismaClient = prisma) {}

  async listActiveAcquisitionGmailConnections(): Promise<AcquisitionGmailConnectionRef[]> {
    const connections = await this.db.acquisitionGmailConnection.findMany({
      where: { active: true },
      select: { id: true, companyId: true, gmailAddress: true },
      orderBy: [{ companyId: "asc" }, { gmailAddress: "asc" }],
    })
    return connections.map((c) => ({
      connectionId: c.id,
      companyId: c.companyId,
      gmailAddress: c.gmailAddress,
    }))
  }
}

export const acquisitionGmailConnectionListingAdapter =
  new PrismaAcquisitionGmailConnectionListingAdapter()
