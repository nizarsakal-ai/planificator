/**
 * PLAN-ACQ-V2 Lot F R2 — Policy pure auto-approve / auto-convert.
 * Fallback unique : HUMAN_REVIEW_REQUIRED (jamais création auto ici).
 */

import { getAcquisitionAutoMinConfidence } from "@/lib/acquisition/policy/auto-decision-feature-flag"

export type AutoDecisionCode =
  | "AUTO_APPROVE_CONVERT"
  | "AUTO_APPROVE_ONLY"
  | "HUMAN_REVIEW_REQUIRED"

export type AutoDecisionInput = {
  worksiteName: string | null
  startDate: Date | null
  endDate: Date | null
  address: string | null
  postalCode?: string | null
  city: string | null
  clientName: string | null
  clientEmail: string | null
  confidenceData: Record<string, number>
  warningData: unknown
  autoApproveEnabled: boolean
  autoConvertEnabled: boolean
  minConfidence?: number
  /** Doublon chantier probable détecté en amont. */
  potentialDuplicate?: boolean
  /** Matching client ambigu (plusieurs hits). */
  clientAmbiguous?: boolean
  /** Au moins une PJ indispensable (PLAN) non lisible. */
  requiredDocumentUnreadable?: boolean
}

export type AutoDecisionResult = {
  code: AutoDecisionCode
  reasons: string[]
  scores: Record<string, number>
}

function warningCodes(warningData: unknown): Set<string> {
  const out = new Set<string>()
  if (!Array.isArray(warningData)) return out
  for (const w of warningData) {
    if (w && typeof w === "object" && typeof (w as { code?: unknown }).code === "string") {
      out.add((w as { code: string }).code)
    }
  }
  return out
}

function hasBlockingWarnings(warningData: unknown): boolean {
  if (!Array.isArray(warningData)) return false
  return warningData.some(
    (w) =>
      w &&
      typeof w === "object" &&
      (w as { blocking?: boolean }).blocking === true
  )
}

export function evaluateAutoDecision(input: AutoDecisionInput): AutoDecisionResult {
  const min = input.minConfidence ?? getAcquisitionAutoMinConfidence()
  const reasons: string[] = []
  const scores = { ...input.confidenceData }
  const codes = warningCodes(input.warningData)

  if (!input.autoApproveEnabled) {
    return { code: "HUMAN_REVIEW_REQUIRED", reasons: ["AUTO_APPROVE_DISABLED"], scores }
  }

  const name = input.worksiteName?.trim() ?? ""
  if (!name) reasons.push("MISSING_WORKSITE_NAME")

  if (!input.startDate || !input.endDate) {
    reasons.push("INVALID_DATES")
  } else if (input.startDate > input.endDate) {
    reasons.push("INVALID_DATES")
  }

  const addr = input.address?.trim() ?? ""
  const city = input.city?.trim() ?? ""
  const postal = input.postalCode?.trim() ?? ""
  // Auto : adresse complète exigée (rue + ville) — sinon ambiguë / incomplète
  if (!addr || !city) {
    reasons.push("AMBIGUOUS_ADDRESS")
  } else if (addr.length < 5) {
    reasons.push("AMBIGUOUS_ADDRESS")
  }

  const hasClient =
    Boolean(input.clientName?.trim()) || Boolean(input.clientEmail?.trim())
  if (!hasClient) reasons.push("MISSING_CLIENT_IDENTITY")

  if (input.clientAmbiguous || codes.has("CLIENT_IDENTITY_AMBIGUOUS")) {
    reasons.push("AMBIGUOUS_CLIENT")
  }

  if (input.potentialDuplicate) {
    reasons.push("POTENTIAL_DUPLICATE")
  }

  if (codes.has("POTENTIAL_PROMPT_INJECTION")) {
    reasons.push("PROMPT_INJECTION_RISK")
  }

  if (
    input.requiredDocumentUnreadable ||
    codes.has("PDF_NO_TEXT_LAYER") ||
    codes.has("PDF_PARSE_FAILED") ||
    codes.has("REQUIRED_DOCUMENT_UNREADABLE")
  ) {
    // PDF_NO_TEXT_LAYER seul n’est bloquant que si marked requiredDocumentUnreadable
    if (
      input.requiredDocumentUnreadable ||
      codes.has("REQUIRED_DOCUMENT_UNREADABLE")
    ) {
      reasons.push("REQUIRED_DOCUMENT_UNREADABLE")
    }
  }

  if (hasBlockingWarnings(input.warningData)) {
    reasons.push("BLOCKING_WARNINGS")
  }

  const requiredConfKeys = [
    "worksiteName",
    "requestedStartDate",
    "requestedEndDate",
  ] as const
  for (const key of requiredConfKeys) {
    const c = input.confidenceData[key]
    if (c == null || c < min) {
      reasons.push(`LOW_CONFIDENCE:${key}`)
    }
  }

  // postal optionnel mais utile pour anti-doublon — pas de raison dédiée si absent

  if (reasons.length > 0) {
    return { code: "HUMAN_REVIEW_REQUIRED", reasons: [...new Set(reasons)], scores }
  }

  if (input.autoConvertEnabled) {
    return { code: "AUTO_APPROVE_CONVERT", reasons: ["THRESHOLDS_OK"], scores }
  }
  return {
    code: "AUTO_APPROVE_ONLY",
    reasons: ["THRESHOLDS_OK", "AUTO_CONVERT_DISABLED"],
    scores,
  }
}
