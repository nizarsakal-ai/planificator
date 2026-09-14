/**
 * PLAN-ACQ-DETECTION-001 — Capability runtime Detection (réutilisable).
 * Autorité des données = DB (companyId + acquisitionMessageId), pas l’input surface.
 * PLAN-ACQ-DETECTION-001-R1 — pas d’autorité lease ; fence TX transmise au repository.
 */

import type {
  ConsultationDetectionCapability,
  ConsultationDetectionInput,
  ConsultationDetectionResult,
} from "@/lib/acquisition/capabilities/consultation-capability.ports"
import { classifyConsultationDetection } from "@/lib/acquisition/capabilities/consultation-detection.policy"
import {
  ConsultationDetectionRepository,
  consultationDetectionRepository,
  type PersistDetectionOutcome,
} from "@/lib/acquisition/capabilities/consultation-detection.repository"
import type { TransactionalOwnershipFence } from "@/lib/acquisition/conversion/conversion-ownership-fence.port"

export type ConsultationDetectionCapabilityDeps = {
  repository?: ConsultationDetectionRepository
  now?: () => Date
  /**
   * Fence TX optionnelle (chemin AUTO). Transmise au repository uniquement —
   * la capability n’est pas une autorité orchestrateur forgeable.
   */
  transactionalOwnershipFence?: TransactionalOwnershipFence
}

/** Outcomes techniques runtime (worker) — hors contrat public ports. */
export type ConsultationDetectionRuntimeResult = ConsultationDetectionResult & {
  persistOutcome: PersistDetectionOutcome | "NO_CONTENT" | "NO_DRAFT"
  contentHash: string | null
  reasons: string[]
}

export class DefaultConsultationDetectionCapability
  implements ConsultationDetectionCapability
{
  constructor(private readonly deps: ConsultationDetectionCapabilityDeps = {}) {}

  async detectConsultation(
    input: ConsultationDetectionInput
  ): Promise<ConsultationDetectionRuntimeResult> {
    const repository = this.deps.repository ?? consultationDetectionRepository
    const now = (this.deps.now ?? (() => new Date()))()

    const snapshot = await repository.loadDetectionSnapshot({
      companyId: input.companyId,
      acquisitionMessageId: input.acquisitionMessageId,
    })

    if (!snapshot) {
      return {
        eligible: false,
        classification: null,
        draftId: null,
        resolvedPartnerId: null,
        partnerCode: null,
        persistOutcome: "NO_DRAFT",
        contentHash: null,
        reasons: ["DRAFT_OR_CONTENT_MISSING"],
      }
    }

    if (!snapshot.normalizedText.trim() || !snapshot.contentHash) {
      return {
        eligible: false,
        classification: null,
        draftId: snapshot.draftId,
        resolvedPartnerId: snapshot.resolvedPartnerId,
        partnerCode: snapshot.partnerCode,
        persistOutcome: "NO_CONTENT",
        contentHash: snapshot.contentHash || null,
        reasons: ["CONTENT_MISSING"],
      }
    }

    const policy = classifyConsultationDetection({
      subject: snapshot.subject,
      normalizedText: snapshot.normalizedText,
      senderEmail: snapshot.senderEmail,
      senderDomain: snapshot.senderDomain,
      resolvedPartnerId: snapshot.resolvedPartnerId,
      partnerActive: snapshot.partnerActive,
      partnerPipeline: snapshot.partnerPipeline,
      attachments: snapshot.attachments,
    })

    const persistOutcome = await repository.persistDetectionProof({
      companyId: snapshot.companyId,
      draftId: snapshot.draftId,
      expectedVersion: snapshot.draftVersion,
      expectedContentHash: snapshot.contentHash,
      classification: policy.classification,
      now,
      transactionalOwnershipFence: this.deps.transactionalOwnershipFence,
    })

    const persisted = persistOutcome === "PERSISTED"

    return {
      eligible: persisted ? policy.eligible : false,
      classification: persisted ? policy.classification : null,
      draftId: snapshot.draftId,
      resolvedPartnerId: snapshot.resolvedPartnerId,
      partnerCode: snapshot.partnerCode,
      persistOutcome,
      contentHash: snapshot.contentHash,
      reasons: policy.reasons,
    }
  }
}

export function createConsultationDetectionCapability(
  deps?: ConsultationDetectionCapabilityDeps
): ConsultationDetectionCapability {
  return new DefaultConsultationDetectionCapability(deps)
}

export const consultationDetectionCapability =
  new DefaultConsultationDetectionCapability()
