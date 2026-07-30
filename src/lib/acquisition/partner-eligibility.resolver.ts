/**
 * PLAN-ACQ-V2 Lot I — Résolution d’éligibilité multi-partenaires via registre.
 *
 * Règles :
 * 1. Match email exact actif → partenaire actif → éligible
 * 2. Sinon match domaine actif → partenaire actif :
 *    - si requireExactEmail → non éligible sans match email
 *    - sinon éligible
 * 3. Sinon non éligible
 *
 * Aucune constante partenaire / domaine hardcodée.
 */

import type {
  AcquisitionPartnerRecord,
  PartnerRegistryRepositoryPort,
} from "@/lib/acquisition/persistence/partner-registry.repository"

export type ResolvedEligiblePartner = {
  partner: AcquisitionPartnerRecord
  matchKind: "EMAIL" | "DOMAIN"
}

export interface PartnerEligibilityResolverPort {
  /** @deprecated préférer resolveEligibleSender — conservé pour compat tests. */
  isDomainEligible(companyId: string, domain: string): Promise<boolean>

  resolveEligibleSender(
    companyId: string,
    senderEmail: string,
    senderDomain: string
  ): Promise<ResolvedEligiblePartner | null>
}

export class PartnerEligibilityResolver implements PartnerEligibilityResolverPort {
  constructor(private readonly registry: PartnerRegistryRepositoryPort) {}

  async isDomainEligible(companyId: string, domain: string): Promise<boolean> {
    if (!companyId) throw new Error("companyId requis")
    if (!domain) return false
    const hit = await this.registry.findPartnerByDomain(companyId, domain)
    if (!hit) return false
    if (!hit.active || !hit.domain.active) return false
    if (hit.requireExactEmail) return false
    return true
  }

  async resolveEligibleSender(
    companyId: string,
    senderEmail: string,
    senderDomain: string
  ): Promise<ResolvedEligiblePartner | null> {
    if (!companyId) throw new Error("companyId requis")

    const byEmail = await this.registry.findPartnerByEmail(companyId, senderEmail)
    if (byEmail && byEmail.active && byEmail.email.active) {
      return { partner: byEmail, matchKind: "EMAIL" }
    }

    const byDomain = await this.registry.findPartnerByDomain(companyId, senderDomain)
    if (!byDomain || !byDomain.active || !byDomain.domain.active) {
      return null
    }
    if (byDomain.requireExactEmail) {
      return null
    }
    return { partner: byDomain, matchKind: "DOMAIN" }
  }
}
