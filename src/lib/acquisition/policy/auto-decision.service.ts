/**
 * PLAN-ACQ-V2 Lot F R2 — Exécution auto-approve / auto-convert + journal.
 * Kill-switch env ∩ policy partenaire. SYSTEM actor validé. Pas de client NEW par défaut.
 */

import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { ImportDraftConversionService } from "@/lib/acquisition/conversion/conversion.service"
import { ImportDraftReviewService } from "@/lib/acquisition/review/import-draft-review.service"
import {
  getAcquisitionAutoMinConfidence,
  isAcquisitionAutoApproveEnabled,
  isAcquisitionAutoConvertEnabled,
} from "@/lib/acquisition/policy/auto-decision-feature-flag"
import { evaluateAutoDecision } from "@/lib/acquisition/policy/auto-decision.policy"
import {
  acquisitionDecisionJournalRepository,
  type AcquisitionDecisionJournalRepository,
} from "@/lib/acquisition/policy/decision-journal.repository"
import {
  resolveValidatedSystemActor,
  type SystemActorResolution,
} from "@/lib/acquisition/policy/system-actor"
import {
  findDuplicateWorksite,
  matchClientForDraft,
  normalizeAddressKey,
  type DuplicateWorksiteHit,
  type ClientMatchResult,
} from "@/lib/acquisition/matching/client-match.service"
import {
  PartnerRegistryRepository,
  type PartnerRegistryRepositoryPort,
} from "@/lib/acquisition/persistence/partner-registry.repository"

const LOG_PREFIX = "[acquisition-auto-decision]"

export type AutoDecisionServiceDeps = {
  db?: PrismaClient
  journal?: AcquisitionDecisionJournalRepository
  review?: ImportDraftReviewService
  conversion?: ImportDraftConversionService
  registry?: PartnerRegistryRepositoryPort
  resolveSystemActor?: (
    companyId: string,
    db?: PrismaClient
  ) => Promise<SystemActorResolution>
  findDuplicate?: (input: {
    companyId: string
    addressKey: string
    postalCode?: string | null
    db?: PrismaClient
  }) => Promise<DuplicateWorksiteHit>
  matchClient?: (input: {
    companyId: string
    clientName: string | null
    clientEmail: string | null
    proposedClientId: string | null
    db?: PrismaClient
  }) => Promise<ClientMatchResult>
  log?: (event: string, payload?: Record<string, unknown>) => void
}

function defaultLog(event: string, payload?: Record<string, unknown>): void {
  if (payload) console.log(`${LOG_PREFIX} ${event}`, payload)
  else console.log(`${LOG_PREFIX} ${event}`)
}

function asConfidenceMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v
  }
  return out
}

function hasRequiredDocUnreadable(warningData: unknown): boolean {
  if (!Array.isArray(warningData)) return false
  return warningData.some(
    (w) =>
      w &&
      typeof w === "object" &&
      ((w as { code?: string }).code === "REQUIRED_DOCUMENT_UNREADABLE" ||
        ((w as { code?: string }).code === "PDF_PARSE_FAILED" &&
          (w as { field?: string }).field === "PLAN") ||
        ((w as { code?: string }).code === "PDF_NO_TEXT_LAYER" &&
          (w as { field?: string }).field === "PLAN"))
  )
}

export async function maybeRunAutoDecisionAfterExtraction(input: {
  companyId: string
  draftId: string
  deps?: AutoDecisionServiceDeps
}): Promise<void> {
  const db = input.deps?.db ?? prisma
  const journal = input.deps?.journal ?? acquisitionDecisionJournalRepository
  const review = input.deps?.review ?? new ImportDraftReviewService({ db })
  const conversion =
    input.deps?.conversion ?? new ImportDraftConversionService({ db })
  const registry =
    input.deps?.registry ?? new PartnerRegistryRepository(db)
  const resolveSystemActor =
    input.deps?.resolveSystemActor ?? resolveValidatedSystemActor
  const findDuplicate = input.deps?.findDuplicate ?? findDuplicateWorksite
  const matchClient = input.deps?.matchClient ?? matchClientForDraft
  const log = input.deps?.log ?? defaultLog

  if (!isAcquisitionAutoApproveEnabled()) return

  const draft = await db.worksiteImportDraft.findFirst({
    where: { id: input.draftId, companyId: input.companyId },
    select: {
      id: true,
      status: true,
      version: true,
      proposedWorksiteName: true,
      proposedClientName: true,
      proposedAddress: true,
      proposedPostalCode: true,
      proposedCity: true,
      proposedStartDate: true,
      proposedEndDate: true,
      proposedContactEmail: true,
      proposedClientId: true,
      confidenceData: true,
      warningData: true,
      extractedData: true,
      acquisitionMessage: {
        select: { resolvedPartnerId: true, senderDomain: true },
      },
    },
  })

  if (!draft || draft.status !== "PENDING_REVIEW") return

  let partnerAutoApprove = false
  let partnerAutoConvert = false
  let allowCreateClient = false
  let minConfidence = getAcquisitionAutoMinConfidence()
  let partnerId: string | null = draft.acquisitionMessage?.resolvedPartnerId ?? null
  let partnerCode: string | null = null

  if (partnerId) {
    const partner = await registry.findPartnerById(input.companyId, partnerId)
    if (partner?.active) {
      partnerAutoApprove = partner.autoApproveEnabled
      partnerAutoConvert = partner.autoConvertEnabled
      allowCreateClient = partner.allowCreateClient === true
      if (partner.minConfidence != null) minConfidence = partner.minConfidence
      partnerCode = partner.code
    }
  } else if (draft.acquisitionMessage?.senderDomain) {
    // Fallback domaine uniquement si le partenaire n’exige pas l’email exact
    // (aligné éligibilité : requireExactEmail=true → domaine seul insuffisant).
    // Fail-closed : pas de rétention ambiguë / partielle des flags auto.
    const byDomain = await registry.findPartnerByDomain(
      input.companyId,
      draft.acquisitionMessage.senderDomain
    )
    if (byDomain?.active && byDomain.requireExactEmail !== true) {
      partnerId = byDomain.id
      partnerAutoApprove = byDomain.autoApproveEnabled
      partnerAutoConvert = byDomain.autoConvertEnabled
      allowCreateClient = byDomain.allowCreateClient === true
      if (byDomain.minConfidence != null) minConfidence = byDomain.minConfidence
      partnerCode = byDomain.code
    }
  }

  const autoApproveEnabled =
    isAcquisitionAutoApproveEnabled() && partnerAutoApprove
  const autoConvertEnabled =
    isAcquisitionAutoConvertEnabled() && partnerAutoConvert

  const addressKey = normalizeAddressKey({
    address: draft.proposedAddress,
    postalCode: draft.proposedPostalCode,
    city: draft.proposedCity,
  })
  const dup = await findDuplicate({
    companyId: input.companyId,
    addressKey,
    postalCode: draft.proposedPostalCode,
    db,
  })

  const clientMatch = await matchClient({
    companyId: input.companyId,
    clientName: draft.proposedClientName,
    clientEmail: draft.proposedContactEmail,
    proposedClientId: draft.proposedClientId,
    db,
  })

  const decision = evaluateAutoDecision({
    worksiteName: draft.proposedWorksiteName,
    startDate: draft.proposedStartDate,
    endDate: draft.proposedEndDate,
    address: draft.proposedAddress,
    postalCode: draft.proposedPostalCode,
    city: draft.proposedCity,
    clientName: draft.proposedClientName,
    clientEmail: draft.proposedContactEmail,
    confidenceData: asConfidenceMap(draft.confidenceData),
    warningData: draft.warningData,
    autoApproveEnabled,
    autoConvertEnabled,
    minConfidence,
    potentialDuplicate: Boolean(dup.worksiteId),
    clientAmbiguous: Boolean(clientMatch.ambiguous),
    requiredDocumentUnreadable: hasRequiredDocUnreadable(draft.warningData),
  })

  const systemActor = await resolveSystemActor(input.companyId, db)

  await journal.append({
    companyId: input.companyId,
    draftId: draft.id,
    decisionCode: decision.code,
    reasons: decision.reasons,
    scores: decision.scores,
    actorUserId: systemActor.ok ? systemActor.userId : null,
    metadata: {
      statusBefore: draft.status,
      version: draft.version,
      partnerId,
      partnerCode,
      minConfidence,
      allowCreateClient,
      systemActorOk: systemActor.ok,
      ...(!systemActor.ok
        ? { systemActorCode: systemActor.code, systemActorReason: systemActor.reason }
        : {}),
    },
  })

  log("DECISION", {
    companyId: input.companyId,
    draftId: draft.id,
    code: decision.code,
    reasons: decision.reasons,
    partnerCode,
  })

  if (decision.code === "HUMAN_REVIEW_REQUIRED") return

  if (!systemActor.ok) {
    await journal.append({
      companyId: input.companyId,
      draftId: draft.id,
      decisionCode: "SYSTEM_ACTOR_INVALID",
      reasons: [systemActor.code, systemActor.reason],
      scores: decision.scores,
      actorUserId: null,
      metadata: { partnerId, partnerCode },
    })
    log("SYSTEM_ACTOR_INVALID", {
      draftId: draft.id,
      code: systemActor.code,
      reason: systemActor.reason,
    })
    return
  }

  const actor = {
    actorUserId: systemActor.userId,
    actorRole: "SYSTEM" as const,
    companyId: input.companyId,
  }

  const approve = await review.approveImportDraft(actor, {
    draftId: draft.id,
    expectedVersion: draft.version,
  })
  if (!approve.ok) {
    log("AUTO_APPROVE_FAILED", { draftId: draft.id, code: approve.code })
    return
  }

  if (decision.code !== "AUTO_APPROVE_CONVERT") return

  // R2-MAJOR-002 : pas de NEW sauf allowCreateClient + identité claire + pas d’ambiguïté
  if (clientMatch.clientId == null) {
    if (
      !allowCreateClient ||
      clientMatch.ambiguous ||
      !(draft.proposedClientName?.trim() || draft.proposedContactEmail?.trim())
    ) {
      log("AUTO_CONVERT_SKIPPED_NO_CLIENT", {
        draftId: draft.id,
        allowCreateClient,
        matchKind: clientMatch.matchKind,
      })
      return
    }
  }

  const convertInput =
    clientMatch.clientId != null
      ? {
          draftId: draft.id,
          expectedVersion: approve.version,
          clientMode: "EXISTING" as const,
          existingClientId: clientMatch.clientId,
          acknowledgeDuplicateWorksite: false,
        }
      : {
          draftId: draft.id,
          expectedVersion: approve.version,
          clientMode: "NEW" as const,
          newClient: {
            name: (draft.proposedClientName ?? "").trim().slice(0, 100),
            email: draft.proposedContactEmail,
            phone: null,
            address: [draft.proposedAddress, draft.proposedPostalCode, draft.proposedCity]
              .filter(Boolean)
              .join(", ")
              .slice(0, 500) || null,
          },
          acknowledgeDuplicateWorksite: false,
        }

  if (convertInput.clientMode === "NEW" && !convertInput.newClient.name) {
    log("AUTO_CONVERT_SKIPPED_NO_CLIENT_NAME", { draftId: draft.id })
    return
  }

  // Doublon : auto interdit (policy déjà, double check)
  if (dup.worksiteId) {
    log("AUTO_CONVERT_BLOCKED_DUPLICATE", {
      draftId: draft.id,
      existingWorksiteId: dup.worksiteId,
    })
    return
  }

  const converted = await conversion.convertImportDraft(actor, convertInput)
  log("AUTO_CONVERT_RESULT", {
    draftId: draft.id,
    ok: converted.ok,
    outcome: converted.ok ? converted.outcome : converted.code,
  })
}
