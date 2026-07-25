/**
 * PLAN-ACQ-012-LOT-1.3 — Accès persistant au registre partenaires d’acquisition.
 *
 * Hors chemin chaud : ne remplace PAS ELIGIBLE_SENDER_DOMAIN / isEligibleSenderDomain.
 * Aucune logique métier, aucun fallback historique, aucun filtre « actif ».
 *
 * Normalisation domaine (lookup uniquement) : trim + lowercase.
 * Les données stockées ne sont jamais modifiées par ce repository.
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

export type AcquisitionPartnerWithDomainRecord = AcquisitionPartnerRecord & {
  domain: AcquisitionPartnerDomainRecord
}

/** Normalisation lookup domaine : trim + lowercase uniquement. */
export function normalizeDomainLookup(domain: string): string {
  return domain.trim().toLowerCase()
}

export interface PartnerRegistryRepositoryPort {
  findPartnerByCode(
    companyId: string,
    code: string
  ): Promise<AcquisitionPartnerRecord | null>

  findPartnerByDomain(
    companyId: string,
    domain: string
  ): Promise<AcquisitionPartnerWithDomainRecord | null>

  findDomain(
    companyId: string,
    domain: string
  ): Promise<AcquisitionPartnerDomainRecord | null>

  listPartners(companyId: string): Promise<AcquisitionPartnerRecord[]>

  listDomains(
    companyId: string,
    partnerId?: string
  ): Promise<AcquisitionPartnerDomainRecord[]>

  partnerExists(companyId: string, code: string): Promise<boolean>

  domainExists(companyId: string, domain: string): Promise<boolean>
}

type PartnerRegistryDb = Pick<
  PrismaClient,
  "acquisitionPartner" | "acquisitionPartnerDomain"
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

/** Seul point d’accès Prisma prévu pour le registre partenaires (LOT-1.3). */
export class PartnerRegistryRepository implements PartnerRegistryRepositoryPort {
  constructor(private readonly db: PartnerRegistryDb = prisma) {}

  async findPartnerByCode(
    companyId: string,
    code: string
  ): Promise<AcquisitionPartnerRecord | null> {
    requireCompanyId(companyId)
    if (!code) return null

    const row = await this.db.acquisitionPartner.findUnique({
      where: {
        companyId_code: { companyId, code },
      },
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
      where: {
        companyId_domainNormalized: { companyId, domainNormalized },
      },
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
      where: {
        companyId_domainNormalized: { companyId, domainNormalized },
      },
      include: { partner: true },
    })
    if (!row) return null

    // Défense en profondeur : la FK composite garantit déjà le même companyId.
    if (row.partner.companyId !== companyId) return null

    const { partner, ...domainRow } = row
    return {
      ...mapPartner(partner),
      domain: mapDomain(domainRow),
    }
  }

  async listPartners(companyId: string): Promise<AcquisitionPartnerRecord[]> {
    requireCompanyId(companyId)

    const rows = await this.db.acquisitionPartner.findMany({
      where: { companyId },
      orderBy: [{ code: "asc" }, { id: "asc" }],
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

  async partnerExists(companyId: string, code: string): Promise<boolean> {
    const partner = await this.findPartnerByCode(companyId, code)
    return partner !== null
  }

  async domainExists(companyId: string, domain: string): Promise<boolean> {
    const row = await this.findDomain(companyId, domain)
    return row !== null
  }
}

export const partnerRegistryRepository = new PartnerRegistryRepository()
