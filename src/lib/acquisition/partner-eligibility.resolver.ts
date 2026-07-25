/**
 * PLAN-ACQ-012-LOT-1.4 — Résolution d’éligibilité via le registre partenaires.
 *
 * Le runtime Acquisition consomme uniquement ce service (pas le repository).
 * Éligible ⇔ domaine trouvé pour le tenant + domaine.active + partenaire.active.
 * Aucun fallback historique, aucune constante hardcodée.
 */

import type { PartnerRegistryRepositoryPort } from "@/lib/acquisition/persistence/partner-registry.repository"

export interface PartnerEligibilityResolverPort {
  /**
   * @param companyId tenant obligatoire
   * @param domain domaine déjà normalisé (ex. sortie de normalizeSenderAddress)
   * @returns true si domaine + partenaire actifs existent pour ce tenant
   * @throws erreurs Prisma du repository (jamais masquées)
   */
  isDomainEligible(companyId: string, domain: string): Promise<boolean>
}

export class PartnerEligibilityResolver implements PartnerEligibilityResolverPort {
  constructor(private readonly registry: PartnerRegistryRepositoryPort) {}

  async isDomainEligible(companyId: string, domain: string): Promise<boolean> {
    if (!companyId) throw new Error("companyId requis")
    if (!domain) return false

    const hit = await this.registry.findPartnerByDomain(companyId, domain)
    if (!hit) return false
    return hit.active === true && hit.domain.active === true
  }
}
