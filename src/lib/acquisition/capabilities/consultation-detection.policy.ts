/**
 * PLAN-ACQ-DETECTION-001 — Politique déterministe fail-closed (pas de LLM).
 * Partenaire autorisé = nécessaire, jamais suffisant.
 * Category PLAN / PDF seul ≠ preuve de consultation.
 */

import type { ConsultationClassification } from "@/lib/acquisition/capabilities/consultation-capability.types"
import { evaluateAutoDecisionSourceFreshness } from "@/lib/acquisition/policy/auto-decision-source-freshness"

export type DetectionAttachmentSignal = {
  filename: string
  mimeType: string
  category: string
}

export type ConsultationDetectionPolicyInput = {
  subject: string | null
  normalizedText: string
  senderEmail: string | null
  senderDomain: string | null
  resolvedPartnerId: string | null
  partnerActive: boolean
  /** Pipeline partenaire SoT — Detection AUTO exige "consultations". */
  partnerPipeline: string | null
  attachments: DetectionAttachmentSignal[]
}

export type ConsultationDetectionPolicyResult = {
  classification: ConsultationClassification
  eligible: boolean
  reasons: string[]
}

/** Classifications autorisant l’extraction AUTO (pas la conversion). */
export const EXTRACTION_AUTHORIZED_DETECTION_CLASSIFICATIONS = [
  "CONSULTATION",
  "CONSULTATION_UPDATE",
  "CANCELLATION",
] as const satisfies readonly ConsultationClassification[]

export type ExtractionAuthorizedDetectionClassification =
  (typeof EXTRACTION_AUTHORIZED_DETECTION_CLASSIFICATIONS)[number]

export function isExtractionAuthorizedDetectionClassification(
  value: ConsultationClassification | null | undefined
): value is ExtractionAuthorizedDetectionClassification {
  return (
    value === "CONSULTATION" ||
    value === "CONSULTATION_UPDATE" ||
    value === "CANCELLATION"
  )
}

/** Auto-conversion SYSTEM : jamais CANCELLATION / NON_CONSULTATION / AMBIGUOUS / NULL. */
export function isAutoConversionAuthorizedDetectionClassification(
  value: ConsultationClassification | null | undefined
): value is "CONSULTATION" | "CONSULTATION_UPDATE" {
  return value === "CONSULTATION" || value === "CONSULTATION_UPDATE"
}

/**
 * UI manual extract ≠ autorisation AUTO.
 * R8 — detection === extraction === currentSource ; AUTO_REJECT_CANCELLED sans exception de fraîcheur.
 */
export function gateAutoDecisionByDetectionProof<T extends { code: string; reasons: string[]; scores: Record<string, number> }>(input: {
  decision: T
  detectionClassification: ConsultationClassification | null | undefined
  detectionContentHash: string | null | undefined
  contentHashAtExtraction: string | null | undefined
  currentSourceContentHash: string | null | undefined
}): T {
  const isAutoMutation =
    input.decision.code === "AUTO_APPROVE_CONVERT" ||
    input.decision.code === "AUTO_APPROVE_ONLY" ||
    input.decision.code === "AUTO_REJECT_CANCELLED"

  const freshness = evaluateAutoDecisionSourceFreshness({
    detectionContentHash: input.detectionContentHash,
    contentHashAtExtraction: input.contentHashAtExtraction,
    currentSourceContentHash: input.currentSourceContentHash,
  })

  if (!freshness.ok) {
    if (!isAutoMutation) return input.decision
    return {
      ...input.decision,
      code: "HUMAN_REVIEW_REQUIRED",
      reasons: ["SOURCE_CONTENT_STALE", freshness.reason],
    }
  }

  if (isAutoConversionAuthorizedDetectionClassification(input.detectionClassification)) {
    if (input.decision.code === "AUTO_REJECT_CANCELLED") {
      // Classification positive ≠ cancellation Detection — fail-closed conversion path only
      return {
        ...input.decision,
        code: "HUMAN_REVIEW_REQUIRED",
        reasons: ["DETECTION_NOT_AUTHORIZED_FOR_AUTO_CONVERSION"],
      }
    }
    return input.decision
  }

  if (input.detectionClassification === "CANCELLATION") {
    if (input.decision.code === "AUTO_REJECT_CANCELLED") {
      return input.decision
    }
    if (
      input.decision.code === "AUTO_APPROVE_CONVERT" ||
      input.decision.code === "AUTO_APPROVE_ONLY"
    ) {
      return {
        ...input.decision,
        code: "HUMAN_REVIEW_REQUIRED",
        reasons: ["DETECTION_NOT_AUTHORIZED_FOR_AUTO_CONVERSION"],
      }
    }
    return input.decision
  }

  if (isAutoMutation) {
    return {
      ...input.decision,
      code: "HUMAN_REVIEW_REQUIRED",
      reasons: ["DETECTION_NOT_AUTHORIZED_FOR_AUTO_CONVERSION"],
    }
  }
  return input.decision
}

function norm(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
}

function countHits(haystack: string, patterns: RegExp[]): number {
  let n = 0
  for (const p of patterns) {
    if (p.test(haystack)) n += 1
  }
  return n
}

const STRONG_NEGATIVE: RegExp[] = [
  /\bfacture\b/,
  /\binvoice\b/,
  /\bfacturation\b/,
  /\br[eè]glement\b/,
  /\bpaiement\b/,
  /\bpayment\b/,
  /\brelev[eé]\s+de\s+compte\b/,
  /\bavoir\b/,
  /\brelance\s+(comptable|paiement|facture)\b/,
  /\bcomptabilit[eé]\b/,
  /\badministration\s+fournisseur\b/,
  /\bribs?\b/,
  /\biban\b/,
  /\bmandat\s+sepa\b/,
]

const AUTO_REPLY: RegExp[] = [
  /\baccuse\s+de\s+reception\b/,
  /\baccus[eé]\s+automatique\b/,
  /\bout\s+of\s+office\b/,
  /\babsence\s+du\s+bureau\b/,
  /\breponse\s+automatique\b/,
  /\bauto[- ]?reply\b/,
  /\bno[- ]?reply\b/,
  /\bne\s+pas\s+repondre\b/,
]

const CANCELLATION: RegExp[] = [
  /\bannulation\b/,
  /\bannule[e]?\b/,
  /\bcancel+ed?\b/,
  /\bcancellation\b/,
  /\bretrait\s+de\s+(la\s+)?consultation\b/,
  /\bne\s+plus\s+(donner\s+)?suite\b/,
]

const STRONG_POSITIVE_CONSULTATION: RegExp[] = [
  /\bconsultation\b/,
  /\bappel\s+d['’]offres?\b/,
  /\bdemande\s+de\s+(devis|prix|prestation)\b/,
  /\bdossier\s+de\s+consultation\b/,
]

const STRONG_POSITIVE_INTERVENTION: RegExp[] = [
  /\bintervention\b/,
  /\btravaux\b/,
  /\bmontage\b/,
  /\bd[eé]montage\b/,
  /\binstallation\b/,
  /\bpose\b/,
  /\bchantier\b/,
  /\bsite\s+(de\s+)?travaux\b/,
  /\bsemaine\s+\d{1,2}\b/,
  /\bdu\s+\d{1,2}[\/.-]\d{1,2}([\/.-]\d{2,4})?\s+au\s+\d{1,2}/,
  /\bp[eé]riode\s+de\s+(travaux|intervention|prestation)\b/,
]

/** Seuls : jamais classification positive. */
const AMBIGUOUS_ALONE: RegExp[] = [
  /\bdevis\b/,
  /\bbon\s+de\s+commande\b/,
  /\bbdc\b/,
  /\brelance\b/,
]

const WORK_CONTEXT: RegExp[] = [
  /\bchantier\b/,
  /\btravaux\b/,
  /\bintervention\b/,
  /\bconsultation\b/,
  /\br[eé]f[eé]rence\b/,
  /\baffaire\b/,
  /\bsite\b/,
  /\badresse\b/,
]

/** Pipeline Detection AUTO — seul pipeline autorisant une classification positive. */
export const CONSULTATION_DETECTION_REQUIRED_PIPELINE = "consultations" as const

/**
 * Classifie de façon déterministe. Jamais de LLM.
 */
export function classifyConsultationDetection(
  input: ConsultationDetectionPolicyInput
): ConsultationDetectionPolicyResult {
  const reasons: string[] = []
  const subject = norm(input.subject)
  const body = norm(input.normalizedText)
  const corpus = `${subject}\n${body}`
  const partnerOk =
    Boolean(input.resolvedPartnerId) &&
    input.partnerActive === true &&
    input.partnerPipeline === CONSULTATION_DETECTION_REQUIRED_PIPELINE

  if (!partnerOk) {
    if (!input.resolvedPartnerId) {
      reasons.push("PARTNER_NOT_AUTHORIZED")
    } else if (!input.partnerActive) {
      reasons.push("PARTNER_INACTIVE")
    } else if (input.partnerPipeline !== CONSULTATION_DETECTION_REQUIRED_PIPELINE) {
      reasons.push("PARTNER_PIPELINE_NOT_CONSULTATIONS")
    } else {
      reasons.push("PARTNER_NOT_AUTHORIZED")
    }
  }

  const neg = countHits(corpus, STRONG_NEGATIVE)
  const auto = countHits(corpus, AUTO_REPLY)
  const cancel = countHits(corpus, CANCELLATION)
  const posConsult = countHits(corpus, STRONG_POSITIVE_CONSULTATION)
  const posInterv = countHits(corpus, STRONG_POSITIVE_INTERVENTION)
  const ambiguousAlone = countHits(corpus, AMBIGUOUS_ALONE)
  const workCtx = countHits(corpus, WORK_CONTEXT)

  const attachmentNames = input.attachments.map((a) => norm(a.filename)).join(" ")
  const attNeg = countHits(attachmentNames, STRONG_NEGATIVE)
  const attPos =
    countHits(attachmentNames, STRONG_POSITIVE_CONSULTATION) +
    countHits(attachmentNames, STRONG_POSITIVE_INTERVENTION)

  // PDF / PLAN seuls : signaux secondaires uniquement, jamais preuve.
  const onlyPlanPdf =
    input.attachments.length > 0 &&
    input.attachments.every(
      (a) =>
        a.category === "PLAN" ||
        (a.mimeType || "").toLowerCase() === "application/pdf" ||
        a.filename.toLowerCase().endsWith(".pdf")
    )
  if (onlyPlanPdf && posConsult + posInterv === 0 && workCtx === 0) {
    reasons.push("PLAN_OR_PDF_NOT_PROOF")
  }

  const strongNeg = neg + attNeg
  const strongPos = posConsult + posInterv + attPos

  if (strongNeg > 0 && strongPos === 0) {
    reasons.push("STRONG_NEGATIVE_SIGNAL")
    return {
      classification: "NON_CONSULTATION",
      eligible: false,
      reasons,
    }
  }

  if (auto > 0 && strongPos === 0 && workCtx === 0) {
    reasons.push("AUTO_REPLY_WITHOUT_BUSINESS_REQUEST")
    return {
      classification: "NON_CONSULTATION",
      eligible: false,
      reasons,
    }
  }

  if (strongNeg > 0 && strongPos > 0) {
    reasons.push("CONFLICTING_SIGNALS")
    return { classification: "AMBIGUOUS", eligible: false, reasons }
  }

  if (cancel > 0 && (posConsult > 0 || workCtx > 0 || cancel >= 2)) {
    if (!partnerOk) {
      reasons.push("CANCELLATION_WITHOUT_PARTNER")
      return { classification: "AMBIGUOUS", eligible: false, reasons }
    }
    reasons.push("CANCELLATION_SIGNAL")
    return { classification: "CANCELLATION", eligible: true, reasons }
  }

  if (ambiguousAlone > 0 && strongPos === 0 && workCtx < 2) {
    reasons.push("AMBIGUOUS_KEYWORD_ALONE")
    return { classification: "AMBIGUOUS", eligible: false, reasons }
  }

  if (!partnerOk) {
    // Condition nécessaire absente → jamais extraction AUTO positive.
    if (strongPos > 0 || workCtx > 0) {
      reasons.push("POSITIVE_WITHOUT_PARTNER")
      return { classification: "AMBIGUOUS", eligible: false, reasons }
    }
    reasons.push("INSUFFICIENT_WITHOUT_PARTNER")
    return { classification: "AMBIGUOUS", eligible: false, reasons }
  }

  if (posInterv >= 2 || (posInterv >= 1 && workCtx >= 1)) {
    reasons.push("INTERVENTION_CONTEXT")
    return {
      classification: "CONSULTATION_UPDATE",
      eligible: true,
      reasons,
    }
  }

  if (posConsult >= 1 && (workCtx >= 1 || posInterv >= 1 || attPos >= 1)) {
    reasons.push("CONSULTATION_CONTEXT")
    return { classification: "CONSULTATION", eligible: true, reasons }
  }

  if (posConsult >= 2 || (posConsult >= 1 && subject.includes("consultation"))) {
    reasons.push("EXPLICIT_CONSULTATION")
    return { classification: "CONSULTATION", eligible: true, reasons }
  }

  if (workCtx >= 3 && (posInterv >= 1 || subject.length > 0)) {
    reasons.push("WORK_CONTEXT_CLUSTER")
    return {
      classification: "CONSULTATION_UPDATE",
      eligible: true,
      reasons,
    }
  }

  reasons.push("INSUFFICIENT_EVIDENCE")
  return { classification: "AMBIGUOUS", eligible: false, reasons }
}
