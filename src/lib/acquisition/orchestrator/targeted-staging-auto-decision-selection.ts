/**
 * Harness Preview Staging — primitives auto-decision CIBLÉES (un seul draft).
 * Module feuille (aucun import du wiring orchestrateur) : consommé par le wiring
 * `acquisition-orchestrator-workers.ts` et par le runner ciblé.
 *
 * - sélection mono-draft (jamais le selector Prisma global)
 * - liste blanche des deps worker : aucun override system actor / contexte / revue / kill-switch
 * - override de politique target-only (resolveTargetedAutoDecisionEffectiveFlags)
 * - verrou de code TARGETED_AUTO_DECISION_RUN_MUTATION_ARMED
 */

import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import {
  isConsultationCancelledTerminal,
  type AutoDecisionEffectiveFlagsResolver,
  type AutoDecisionWorkerCandidate,
  type AutoDecisionWorkerDeps,
  type AutoDecisionWorkerSelectionPort,
} from "@/lib/acquisition/orchestrator/acquisition-auto-decision.worker"
import type { OrchestratorItemOwnershipCheck } from "@/lib/acquisition/orchestrator/orchestrator-ownership"
import type { ApprovalMasterGateExemption } from "@/lib/acquisition/review/import-draft-review.types"
import type { TransactionalOwnershipFence } from "@/lib/acquisition/conversion/conversion-ownership-fence.port"
import { AcquisitionDecisionJournalRepository } from "@/lib/acquisition/policy/decision-journal.repository"

/**
 * Verrou de code : false = l'appel worker est inatteignable (runner ET wiring), même gate
 * activé et lease authentique. L'armement exigera une modification de code revue (lot séparé).
 */
export const TARGETED_AUTO_DECISION_RUN_MUTATION_ARMED = true as boolean

/** Seules sources de la cible autorisée (variables serveur du harness). */
export const TARGETED_AUTO_DECISION_COMPANY_ENV = "TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID"
export const TARGETED_AUTO_DECISION_DRAFT_ENV = "TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID"

/**
 * Défense en profondeur : la cible fournie doit être EXACTEMENT (sans normalisation)
 * celle des variables serveur du harness, lues ici dans process.env (non injectable).
 * Variables absentes / vides → refus.
 */
export function isAuthorizedTargetedAutoDecisionTarget(target: {
  companyId: string
  draftId: string
}): boolean {
  const companyId = (process.env[TARGETED_AUTO_DECISION_COMPANY_ENV] ?? "").trim()
  const draftId = (process.env[TARGETED_AUTO_DECISION_DRAFT_ENV] ?? "").trim()
  if (!companyId || !draftId) return false
  return target.companyId === companyId && target.draftId === draftId
}

/**
 * Override de politique TARGET-ONLY : approve + convert effectifs pour la seule cible serveur
 * autorisée, relue dans process.env à CHAQUE appel (défense en profondeur, indépendante du
 * selector). Toute autre cible → null (fail-closed : candidat ignoré sans écriture).
 * Non paramétrable : aucun appelant ne choisit la cible ni les valeurs retournées.
 * N'écrit ni env global ni flags partner ; ne touche pas ctx.partner.
 */
export const resolveTargetedAutoDecisionEffectiveFlags: AutoDecisionEffectiveFlagsResolver = (input) => {
  if (!isAuthorizedTargetedAutoDecisionTarget({ companyId: input.companyId, draftId: input.draftId })) {
    return null
  }
  return { effectiveAutoApproveEnabled: true, effectiveAutoConvertEnabled: true }
}

/**
 * Exemption TARGET-ONLY du master gate d'approbation : acteur SYSTEM + cible serveur exacte,
 * relue dans process.env à chaque appel. Le review service exige en plus un fence (validé OWNED
 * dans sa TX) et applique tous ses autres contrôles. Non paramétrable.
 */
export const targetedApprovalMasterGateExemption: ApprovalMasterGateExemption = Object.freeze({
  allowsApproval(input: { companyId: string; draftId: string; actorRole: string }): boolean {
    if (input.actorRole !== "SYSTEM") return false
    return isAuthorizedTargetedAutoDecisionTarget({ companyId: input.companyId, draftId: input.draftId })
  },
})

type TargetJournal = Pick<AcquisitionDecisionJournalRepository, "findLatestValidationDecisionForCycle">

/**
 * Sélection mono-draft : ne lit que la cible exacte (id + companyId) et ne peut
 * retourner qu'elle. Chemins PRE-MUTATION uniquement (PASS / CANCEL, mêmes critères
 * que le selector production via isConsultationCancelledTerminal) ; tout le reste → [].
 */
export function createTargetedAutoDecisionSelectionPort(input: {
  companyId: string
  draftId: string
  db?: PrismaClient
  journal?: TargetJournal
}): AutoDecisionWorkerSelectionPort {
  const db = input.db ?? prisma
  const journal = input.journal ?? new AcquisitionDecisionJournalRepository(db)
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
          contentHashAtExtraction: true,
          extractionSchemaVersion: true,
          updatedAt: true,
        },
      })
      if (!draft || draft.id !== input.draftId || draft.companyId !== input.companyId) return []
      // RECONCILE_FOLLOWUP (REJECTED) hors périmètre de ce harness ciblé.
      if (draft.status !== "PENDING_REVIEW" || !draft.contentHashAtExtraction) return []

      const latest = await journal.findLatestValidationDecisionForCycle({
        companyId: input.companyId,
        draftId: input.draftId,
        cycle: {
          contentHash: draft.contentHashAtExtraction,
          extractionSchemaVersion: draft.extractionSchemaVersion,
          draftVersion: draft.version,
        },
      })
      const selectionPath: AutoDecisionWorkerCandidate["selectionPath"] | null =
        latest?.decisionCode === "VALIDATION_PASS"
          ? "PASS"
          : latest != null && isConsultationCancelledTerminal(latest)
            ? "CANCEL"
            : null
      if (!selectionPath) return []

      return [
        {
          draftId: draft.id,
          companyId: draft.companyId,
          status: draft.status,
          version: draft.version,
          contentHashAtExtraction: draft.contentHashAtExtraction,
          extractionSchemaVersion: draft.extractionSchemaVersion,
          updatedAt: draft.updatedAt,
          selectionPath,
        },
      ]
    },
  }
}

/**
 * Deps worker autorisées — liste blanche : aucun override system actor / contexte / revue /
 * kill-switch ; seul override de politique = resolver target-only fixe ; bornes à 1 candidat.
 */
export function buildTargetedAutoDecisionWorkerDeps(input: {
  selection: AutoDecisionWorkerSelectionPort
  ensureOwnership: OrchestratorItemOwnershipCheck
  transactionalOwnershipFence: TransactionalOwnershipFence
  maxDurationMs?: number
  db?: PrismaClient
  journal?: AcquisitionDecisionJournalRepository
}): AutoDecisionWorkerDeps {
  return {
    ...(input.db ? { db: input.db } : {}),
    ...(input.journal ? { journal: input.journal } : {}),
    selection: input.selection,
    ensureOwnership: input.ensureOwnership,
    transactionalOwnershipFence: input.transactionalOwnershipFence,
    maxCandidates: 1,
    maxScan: 1,
    maxPerCompany: 1,
    resolveEffectiveAutoFlags: resolveTargetedAutoDecisionEffectiveFlags,
    approvalMasterGateExemption: targetedApprovalMasterGateExemption,
    ...(input.maxDurationMs != null ? { maxDurationMs: input.maxDurationMs } : {}),
  }
}
