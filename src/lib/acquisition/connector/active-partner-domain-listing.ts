/**
 * PLAN-ACQ-V2 Lot D / R2 — Identités partenaires actives (domaines + emails).
 */

import {
  PartnerRegistryRepository,
  type PartnerRegistryRepositoryPort,
} from "@/lib/acquisition/persistence/partner-registry.repository"

export type ActivePartnerIdentities = {
  domains: string[]
  emails: string[]
}

export interface ActivePartnerIdentityListingPort {
  listActiveIdentities(companyId: string): Promise<ActivePartnerIdentities>
  /** @deprecated compat — domaines seuls. */
  listActiveDomains(companyId: string): Promise<string[]>
}

export class ActivePartnerDomainListingService
  implements ActivePartnerIdentityListingPort
{
  constructor(
    private readonly registry: PartnerRegistryRepositoryPort = new PartnerRegistryRepository()
  ) {}

  async listActiveIdentities(companyId: string): Promise<ActivePartnerIdentities> {
    if (!companyId) return { domains: [], emails: [] }
    const [partners, domains, emails] = await Promise.all([
      this.registry.listPartners(companyId),
      this.registry.listDomains(companyId),
      this.registry.listEmails(companyId),
    ])
    const activePartnerIds = new Set(
      partners.filter((p) => p.active).map((p) => p.id)
    )
    const domainSet = new Set<string>()
    for (const d of domains) {
      if (!d.active) continue
      if (!activePartnerIds.has(d.partnerId)) continue
      const norm = d.domainNormalized.trim().toLowerCase()
      if (norm) domainSet.add(norm)
    }
    const emailSet = new Set<string>()
    for (const e of emails) {
      if (!e.active) continue
      if (!activePartnerIds.has(e.partnerId)) continue
      const norm = e.emailNormalized.trim().toLowerCase()
      if (norm && norm.includes("@")) emailSet.add(norm)
    }
    return {
      domains: [...domainSet].sort(),
      emails: [...emailSet].sort(),
    }
  }

  async listActiveDomains(companyId: string): Promise<string[]> {
    const ids = await this.listActiveIdentities(companyId)
    return ids.domains
  }
}

export const activePartnerDomainListing = new ActivePartnerDomainListingService()
