/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2, référence de parité indépendante sous LOT-3.
 *
 * Quand l'admission Consultations du LOT-3 est active, le résultat transmis par la synchronisation vient du Router :
 * comparer le Router à ce résultat revient à le comparer à lui-même. Cette référence rejoue, en lecture seule, les
 * règles historiques d'éligibilité (registre partenaires : email exact actif, sinon domaine actif hors « email exact
 * requis ») exactement comme `registerIncomingMessage` les applique, sans rien créer ni modifier.
 *
 * - Lecture seule : uniquement `resolveEligibleSender` du registre ; aucun message, brouillon ni journal écrit.
 * - Aucune valeur d'expéditeur n'est renvoyée ni journalisée : seulement la classe de résultat.
 */
import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { normalizeSenderAddress } from "@/lib/acquisition/normalize-sender-address"
import {
  PartnerEligibilityResolver,
  type PartnerEligibilityResolverPort,
} from "@/lib/acquisition/partner-eligibility.resolver"
import { PartnerRegistryRepository } from "@/lib/acquisition/persistence/partner-registry.repository"

/** Mêmes libellés que les résultats bruts du legacy, pour réutiliser la classification de parité L1. */
export type LegacyEligibilityReferenceOutcome = "DRAFT_CREATED" | "REJECTED"

export type LegacyEligibilityReader = Pick<PartnerEligibilityResolverPort, "resolveEligibleSender">

export function defaultLegacyEligibilityReader(db: PrismaClient = prisma): LegacyEligibilityReader {
  return new PartnerEligibilityResolver(new PartnerRegistryRepository(db))
}

/** Ce que le flux historique aurait décidé pour cet expéditeur, sans aucune écriture. */
export async function evaluateLegacyEligibilityReference(
  companyId: string,
  senderEmail: string,
  reader: LegacyEligibilityReader
): Promise<LegacyEligibilityReferenceOutcome> {
  const sender = normalizeSenderAddress(senderEmail)
  if (!sender) return "REJECTED"
  const resolved = await reader.resolveEligibleSender(companyId, sender.email, sender.domain)
  return resolved ? "DRAFT_CREATED" : "REJECTED"
}
