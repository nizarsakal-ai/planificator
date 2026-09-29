/**
 * Harness Preview Staging — primitives auto-decision CIBLÉES (un seul draft).
 * Module feuille (aucun import du wiring orchestrateur) : consommé par le wiring
 * `acquisition-orchestrator-workers.ts` et par le runner ciblé.
 *
 * - sélection mono-draft (jamais le selector Prisma global)
 * - liste blanche des deps worker : aucun override politique / system actor / contexte / revue
 * - verrou de code TARGETED_AUTO_DECISION_RUN_MUTATION_ARMED
 */

import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import {
  isConsultationCancelledTerminal,
  type AutoDecisionWorkerCandidate,
  type AutoDecisionWorkerDeps,
  type AutoDecisionWorkerSelectionPort,
} from "@/lib/acquisition/orchestrator/acquisition-auto-decision.worker"
import type { OrchestratorItemOwnershipCheck } from "@/lib/acquisition/orchestrator/orchestrator-ownership"
import type { TransactionalOwnershipFence } from "@/lib/acquisition/conversion/conversion-ownership-fence.port"
import { AcquisitionDecisionJournalRepository } from "@/lib/acquisition/policy/decision-journal.repository"

/**
 * Verrou de code : false = l'appel worker est inatteignable (runner ET wiring), même gate
 * activé et lease authentique. L'armement exigera une modification de code revue (lot séparé).
 */
export const TARGETED_AUTO_DECISION_RUN_MUTATION_ARMED = false as boolean

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

type TargetJournal =Pick<AcquisitionDecisionJournalRepository, "findLatestValidationDecisionForCycle">

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
 * Deps worker autorisées — liste blanche : aucune clé de politique / system actor /
 * contexte / revue ; bornes à 1 candidat.
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
    ...(input.maxDurationMs != null ? { maxDurationMs: input.maxDurationMs } : {}),
  }
}
