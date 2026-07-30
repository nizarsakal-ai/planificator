/**
 * PLAN-ACQ-V2 Lot I — Accès persistant registre partenaires (SoT).
 * Pas de filtre « actif » ici — l’éligibilité est dans PartnerEligibilityResolver.
 */

import type { AcquisitionSource, PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"

export type AcquisitionPartnerRecord = {
  id: string
  companyId: string
  name: string
  code: string
  connector: AcquisitionSource
  pipeline: string
  active: boolean
  priority: number
  requireExactEmail: boolean
  autoApproveEnabled: boolean
  autoConvertEnabled: boolean
  allowCreateClient: boolean
  minConfidence: number | null
  createdAt: Date
  updatedAt: Date
}

export type AcquisitionPartnerDomainRecord = {
  id: string
  companyId: string
  partnerId: string
  domainNormalized: string
  active: boolean
  createdAt: Date
  updatedAt: Date
}

export type AcquisitionPartnerEmailRecord = {
  id: string
  companyId: string
  partnerId: string
  emailNormalized: string
  active: boolean
  createdAt: Date
  updatedAt: Date
}

export type AcquisitionPartnerWithDomainRecord = AcquisitionPartnerRecord & {
  domain: AcquisitionPartnerDomainRecord
}

export type AcquisitionPartnerWithEmailRecord = AcquisitionPartnerRecord & {
  email: AcquisitionPartnerEmailRecord
}

export function normalizeDomainLookup(domain: string): string {
  return domain.trim().toLowerCase()
}

export function normalizeEmailLookup(email: string): string {
  return email.trim().toLowerCase()
}

export interface PartnerRegistryRepositoryPort {
  findPartnerByCode(
    companyId: string,
    code: string
  ): Promise<AcquisitionPartnerRecord | null>

  findPartnerById(
    companyId: string,
    partnerId: string
  ): Promise<AcquisitionPartnerRecord | null>

  findPartnerByDomain(
    companyId: string,
    domain: string
  ): Promise<AcquisitionPartnerWithDomainRecord | null>

  findPartnerByEmail(
    companyId: string,
    email: string
  ): Promise<AcquisitionPartnerWithEmailRecord | null>

  findDomain(
    companyId: string,
    domain: string
  ): Promise<AcquisitionPartnerDomainRecord | null>

  listPartners(companyId: string): Promise<AcquisitionPartnerRecord[]>

  listDomains(
    companyId: string,
    partnerId?: string
  ): Promise<AcquisitionPartnerDomainRecord[]>

  listEmails(
    companyId: string,
    partnerId?: string
  ): Promise<AcquisitionPartnerEmailRecord[]>

  partnerExists(companyId: string, code: string): Promise<boolean>

  domainExists(companyId: string, domain: string): Promise<boolean>
}

type PartnerRegistryDb = Pick<
  PrismaClient,
  "acquisitionPartner" | "acquisitionPartnerDomain" | "acquisitionPartnerEmail"
>

function requireCompanyId(companyId: string): void {
  if (!companyId) throw new Error("companyId requis")
}

function mapPartner(row: AcquisitionPartnerRecord): AcquisitionPartnerRecord {
  return { ...row }
}

function mapDomain(
  row: AcquisitionPartnerDomainRecord
): AcquisitionPartnerDomainRecord {
  return { ...row }
}

function mapEmail(
  row: AcquisitionPartnerEmailRecord
): AcquisitionPartnerEmailRecord {
  return { ...row }
}

export class PartnerRegistryRepository implements PartnerRegistryRepositoryPort {
  constructor(private readonly db: PartnerRegistryDb = prisma) {}

  async findPartnerByCode(
    companyId: string,
    code: string
  ): Promise<AcquisitionPartnerRecord | null> {
    requireCompanyId(companyId)
    if (!code) return null
    const row = await this.db.acquisitionPartner.findUnique({
      where: { companyId_code: { companyId, code } },
    })
    return row ? mapPartner(row) : null
  }

  async findPartnerById(
    companyId: string,
    partnerId: string
  ): Promise<AcquisitionPartnerRecord | null> {
    requireCompanyId(companyId)
    if (!partnerId) return null
    const row = await this.db.acquisitionPartner.findFirst({
      where: { id: partnerId, companyId },
    })
    return row ? mapPartner(row) : null
  }

  async findDomain(
    companyId: string,
    domain: string
  ): Promise<AcquisitionPartnerDomainRecord | null> {
    requireCompanyId(companyId)
    const domainNormalized = normalizeDomainLookup(domain)
    if (!domainNormalized) return null
    const row = await this.db.acquisitionPartnerDomain.findUnique({
      where: { companyId_domainNormalized: { companyId, domainNormalized } },
    })
    return row ? mapDomain(row) : null
  }

  async findPartnerByDomain(
    companyId: string,
    domain: string
  ): Promise<AcquisitionPartnerWithDomainRecord | null> {
    requireCompanyId(companyId)
    const domainNormalized = normalizeDomainLookup(domain)
    if (!domainNormalized) return null
    const row = await this.db.acquisitionPartnerDomain.findUnique({
      where: { companyId_domainNormalized: { companyId, domainNormalized } },
      include: { partner: true },
    })
    if (!row) return null
    if (row.partner.companyId !== companyId) return null
    const { partner, ...domainRow } = row
    return { ...mapPartner(partner), domain: mapDomain(domainRow) }
  }

  async findPartnerByEmail(
    companyId: string,
    email: string
  ): Promise<AcquisitionPartnerWithEmailRecord | null> {
    requireCompanyId(companyId)
    const emailNormalized = normalizeEmailLookup(email)
    if (!emailNormalized) return null
    const row = await this.db.acquisitionPartnerEmail.findUnique({
      where: { companyId_emailNormalized: { companyId, emailNormalized } },
      include: { partner: true },
    })
    if (!row) return null
    if (row.partner.companyId !== companyId) return null
    const { partner, ...emailRow } = row
    return { ...mapPartner(partner), email: mapEmail(emailRow) }
  }

  async listPartners(companyId: string): Promise<AcquisitionPartnerRecord[]> {
    requireCompanyId(companyId)
    const rows = await this.db.acquisitionPartner.findMany({
      where: { companyId },
      orderBy: [{ priority: "asc" }, { code: "asc" }, { id: "asc" }],
    })
    return rows.map(mapPartner)
  }

  async listDomains(
    companyId: string,
    partnerId?: string
  ): Promise<AcquisitionPartnerDomainRecord[]> {
    requireCompanyId(companyId)
    const rows = await this.db.acquisitionPartnerDomain.findMany({
      where: {
        companyId,
        ...(partnerId ? { partnerId } : {}),
      },
      orderBy: [{ domainNormalized: "asc" }, { id: "asc" }],
    })
    return rows.map(mapDomain)
  }

  async listEmails(
    companyId: string,
    partnerId?: string
  ): Promise<AcquisitionPartnerEmailRecord[]> {
    requireCompanyId(companyId)
    const rows = await this.db.acquisitionPartnerEmail.findMany({
      where: {
        companyId,
        ...(partnerId ? { partnerId } : {}),
      },
      orderBy: [{ emailNormalized: "asc" }, { id: "asc" }],
    })
    return rows.map(mapEmail)
  }

  async partnerExists(companyId: string, code: string): Promise<boolean> {
    return (await this.findPartnerByCode(companyId, code)) !== null
  }

  async domainExists(companyId: string, domain: string): Promise<boolean> {
    return (await this.findDomain(companyId, domain)) !== null
  }
}

export const partnerRegistryRepository = new PartnerRegistryRepository()
