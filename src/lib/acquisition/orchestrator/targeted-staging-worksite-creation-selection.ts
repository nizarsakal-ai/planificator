/**
 * Harness staging — primitives worksiteCreation CIBLÉES (un seul draft).
 * Module feuille (aucun import du wiring orchestrateur) : consommé par le wiring
 * `acquisition-orchestrator-workers.ts` et par le script manuel ciblé.
 *
 * - sélection mono-draft (jamais le selector SQL global createPrismaWorksiteCreationSelectionPort)
 * - exemption TARGET-ONLY du gate conversion (cible serveur relue à chaque appel)
 * - liste blanche des deps worker : aucun override conversion / system actor / contexte / journal
 */

import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import type { ConversionMasterGateExemption } from "@/lib/acquisition/conversion/conversion.types"
import type { ConversionTransactionalOwnershipFence } from "@/lib/acquisition/conversion/conversion-ownership-fence.port"
import type {
  WorksiteCreationWorkerDeps,
  WorksiteCreationWorkerSelectionPort,
} from "@/lib/acquisition/orchestrator/acquisition-worksite-creation.worker"
import type { OrchestratorItemOwnershipCheck } from "@/lib/acquisition/orchestrator/orchestrator-ownership"
import { isAuthorizedTargetedAutoDecisionTarget } from "@/lib/acquisition/orchestrator/targeted-staging-auto-decision-selection"

/**
 * Exemption TARGET-ONLY du gate conversion : acteur SYSTEM + cible serveur exacte
 * (TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID / _DRAFT_ID, relues dans process.env à chaque
 * appel). Le service exige en plus un fence (validé OWNED en tête de TX) et une entrée valide,
 * et applique tous ses autres contrôles. Non paramétrable.
 */
export const targetedConversionMasterGateExemption: ConversionMasterGateExemption = Object.freeze({
  allowsConversion(input: { companyId: string; draftId: string; actorRole: string }): boolean {
    if (input.actorRole !== "SYSTEM") return false
    return isAuthorizedTargetedAutoDecisionTarget({ companyId: input.companyId, draftId: input.draftId })
  },
})

/**
 * Sélection mono-draft : lecture de la cible exacte (id + companyId) uniquement.
 * Pré-filtre d'éligibilité minimal (APPROVED, sans chantier, hash présent) ; le worker
 * applique ensuite sa machine d'état complète (intent, association directe, acteur, client…).
 */
export function createTargetedWorksiteCreationSelectionPort(input: {
  companyId: string
  draftId: string
  db?: PrismaClient
}): WorksiteCreationWorkerSelectionPort {
  const db = input.db ?? prisma
  return {
    async listEligibleCandidates(request) {
      if (!(request.limit >= 1)) return []
      const draft = await db.worksiteImportDraft.findFirst({
        where: { id: input.draftId, companyId: input.companyId },
        select: {
          id: true,
          companyId: true,
          status: true,
          version: true,
          createdWorksiteId: true,
          contentHashAtExtraction: true,
          extractionSchemaVersion: true,
          updatedAt: true,
        },
      })
      if (!draft || draft.id !== input.draftId || draft.companyId !== input.companyId) return []
      if (draft.status !== "APPROVED" || draft.createdWorksiteId != null || !draft.contentHashAtExtraction) {
        return []
      }
      return [
        {
          draftId: draft.id,
          companyId: draft.companyId,
          status: draft.status,
          version: draft.version,
          contentHashAtExtraction: draft.contentHashAtExtraction,
          extractionSchemaVersion: draft.extractionSchemaVersion,
          updatedAt: draft.updatedAt,
        },
      ]
    },
  }
}

/**
 * Deps worker autorisées — liste blanche : sélection mono-draft, ownership + fence de la
 * capability, exemption target-only figée, bornes à 1. Aucun override conversion / system
 * actor / contexte d'évaluation / journal : chemins et contrôles production.
 */
export function buildTargetedWorksiteCreationWorkerDeps(input: {
  selection: WorksiteCreationWorkerSelectionPort
  ensureOwnership: OrchestratorItemOwnershipCheck
  transactionalOwnershipFence: ConversionTransactionalOwnershipFence
  maxDurationMs?: number
}): WorksiteCreationWorkerDeps {
  return {
    selection: input.selection,
    ensureOwnership: input.ensureOwnership,
    transactionalOwnershipFence: input.transactionalOwnershipFence,
    conversionMasterGateExemption: targetedConversionMasterGateExemption,
    maxCandidates: 1,
    maxScan: 1,
    maxPerCompany: 1,
    ...(input.maxDurationMs != null ? { maxDurationMs: input.maxDurationMs } : {}),
  }
}
