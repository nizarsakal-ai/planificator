/**
 * PLAN-BOOKING-INTENT-DIAG-001 / R1 — Instrumentation temporaire (AMBIGU).
 * Activée uniquement si BOOKING_INTENT_DIAGNOSTICS=true.
 * Aucun impact sur le classifieur ni sur les décisions métier.
 * Observe evidence[] uniquement — ne recalcule aucun seuil CONFIRMATION.
 * Ne log jamais : sujet, corps, email complet, téléphone, adresse, nom voyageur.
 */

import type {
  BookingEmailClassification,
  BookingEmailConfidence,
} from "@/lib/booking/booking-email-intent"

const DIAG_LOG_PREFIX = "[booking-intent-diag]"

/** Codes structurels connus émis par le classifieur (observation seule). */
const STRUCT_EVIDENCE_CODES = [
  "struct:dates",
  "struct:booking_ref",
  "struct:property",
  "struct:address",
] as const

type StructuralEvidenceCode = (typeof STRUCT_EVIDENCE_CODES)[number]

type GmailHeader = { name?: string | null; value?: string | null }

export type BookingAmbiguousDecisionPath =
  | "partial_structure_ref_without_dates"
  | "lexicon_without_structure"
  | "no_decisive_signal"
  | "unknown_ambiguous"

/**
 * Payload diagnostic — aucun sujet, aucun body, aucune PII de contenu.
 * structuralScore = nombre de codes struct:* présents dans evidence (observation).
 */
export type BookingAmbiguousIntentDiagnostic = {
  messageId: string
  companyId: string
  /** Domaine expéditeur uniquement — jamais l'adresse complète. */
  senderDomain: string | null
  evidence: string[]
  structuralScore: number
  confidence: BookingEmailConfidence
  finalDecision: "AMBIGU"
  decisionPath: BookingAmbiguousDecisionPath
  /** Codes struct:* présents dans evidence (descriptif). */
  observedStructuralSignals: StructuralEvidenceCode[]
  /** Codes struct:* absents de evidence (descriptif, sans seuil métier). */
  missingObservedStructuralSignals: StructuralEvidenceCode[]
}

export function isBookingIntentDiagnosticsEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.BOOKING_INTENT_DIAGNOSTICS === "true"
}

/**
 * Header From brut (pour extraction domaine uniquement).
 * Ne jamais logger la valeur retournée telle quelle.
 * À n'appeler que derrière la garde BOOKING_INTENT_DIAGNOSTICS=true.
 */
export function extractGmailFromHeader(
  payload: { headers?: GmailHeader[] | null } | null | undefined
): string {
  const headers = payload?.headers
  if (!Array.isArray(headers)) return ""
  for (const h of headers) {
    if (typeof h?.name === "string" && h.name.toLowerCase() === "from") {
      return typeof h.value === "string" ? h.value.trim() : ""
    }
  }
  return ""
}

/**
 * Extrait uniquement le domaine d'une valeur header From.
 * Accepte « Name <user@domain> » ou « user@domain ».
 * Retourne null si aucun domaine fiable — jamais la partie locale.
 */
export function extractSenderDomainOnly(fromHeaderValue: string): string | null {
  if (typeof fromHeaderValue !== "string" || fromHeaderValue.length === 0) {
    return null
  }
  const angle = fromHeaderValue.match(/<([^<>@\s]+@([^<>@\s]+))>/)
  if (angle?.[2]) {
    const domain = angle[2].trim().toLowerCase()
    return isPlausibleDomain(domain) ? domain : null
  }
  const bare = fromHeaderValue.match(
    /(?:^|[\s,;:])([A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,}))(?:$|[\s,;>])/i
  )
  if (bare?.[2]) {
    const domain = bare[2].trim().toLowerCase()
    return isPlausibleDomain(domain) ? domain : null
  }
  return null
}

function isPlausibleDomain(domain: string): boolean {
  if (!domain || domain.length > 253) return false
  if (domain.includes("@") || domain.includes(" ")) return false
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(domain) && domain.includes(".")
}

/** Mappe un code ambig:* déjà émis par le classifieur — pas de reclassification. */
export function resolveAmbiguousDecisionPath(
  evidence: string[]
): BookingAmbiguousDecisionPath {
  if (evidence.includes("ambig:partial_structure")) {
    return "partial_structure_ref_without_dates"
  }
  if (evidence.includes("ambig:lexicon_without_structure")) {
    return "lexicon_without_structure"
  }
  if (evidence.includes("ambig:no_decisive_signal")) {
    return "no_decisive_signal"
  }
  return "unknown_ambiguous"
}

/**
 * Observation pure des codes struct:* dans evidence[].
 * Aucun seuil CONFIRMATION, aucune règle métier recalculée.
 */
export function observeStructuralSignalsFromEvidence(evidence: string[]): {
  structuralScore: number
  observedStructuralSignals: StructuralEvidenceCode[]
  missingObservedStructuralSignals: StructuralEvidenceCode[]
  decisionPath: BookingAmbiguousDecisionPath
} {
  const observedStructuralSignals = STRUCT_EVIDENCE_CODES.filter((code) =>
    evidence.includes(code)
  )
  const missingObservedStructuralSignals = STRUCT_EVIDENCE_CODES.filter(
    (code) => !evidence.includes(code)
  )
  return {
    structuralScore: observedStructuralSignals.length,
    observedStructuralSignals: [...observedStructuralSignals],
    missingObservedStructuralSignals: [...missingObservedStructuralSignals],
    decisionPath: resolveAmbiguousDecisionPath(evidence),
  }
}

export function buildAmbiguousIntentDiagnostic(input: {
  messageId: string
  companyId: string
  senderDomain: string | null
  classification: BookingEmailClassification
}): BookingAmbiguousIntentDiagnostic | null {
  if (input.classification.intent !== "AMBIGU") return null

  const observed = observeStructuralSignalsFromEvidence(
    input.classification.evidence
  )

  return {
    messageId: input.messageId,
    companyId: input.companyId,
    senderDomain: input.senderDomain,
    evidence: [...input.classification.evidence],
    structuralScore: observed.structuralScore,
    confidence: input.classification.confidence,
    finalDecision: "AMBIGU",
    decisionPath: observed.decisionPath,
    observedStructuralSignals: observed.observedStructuralSignals,
    missingObservedStructuralSignals: observed.missingObservedStructuralSignals,
  }
}

/** Payload JSON sûr — champs contrôlés uniquement (pas de subject). */
export function formatAmbiguousIntentDiagnosticLog(
  diagnostic: BookingAmbiguousIntentDiagnostic
): string {
  return (
    `${DIAG_LOG_PREFIX} ` +
    JSON.stringify({
      messageId: diagnostic.messageId,
      companyId: diagnostic.companyId,
      senderDomain: diagnostic.senderDomain,
      evidence: diagnostic.evidence,
      structuralScore: diagnostic.structuralScore,
      confidence: diagnostic.confidence,
      finalDecision: diagnostic.finalDecision,
      decisionPath: diagnostic.decisionPath,
      observedStructuralSignals: diagnostic.observedStructuralSignals,
      missingObservedStructuralSignals:
        diagnostic.missingObservedStructuralSignals,
    })
  )
}

export type MaybeLogAmbiguousIntentDiagnosticInput = {
  messageId: string
  companyId: string
  classification: BookingEmailClassification
  /**
   * Fournit le header From uniquement si le diagnostic est réellement actif.
   * Ne doit pas être évalué lorsque le flag est OFF (coût minimal).
   */
  getFromHeaderValue: () => string
}

/**
 * Log conditionnel. Retourne true si un log a été émis.
 * Flag OFF → return immédiat, aucune extraction From / build / derive.
 */
export function maybeLogAmbiguousIntentDiagnostic(
  input: MaybeLogAmbiguousIntentDiagnosticInput,
  options?: {
    env?: NodeJS.ProcessEnv
    logFn?: (line: string) => void
  }
): boolean {
  const env = options?.env ?? process.env
  if (!isBookingIntentDiagnosticsEnabled(env)) return false
  if (input.classification.intent !== "AMBIGU") return false

  const diagnostic = buildAmbiguousIntentDiagnostic({
    messageId: input.messageId,
    companyId: input.companyId,
    senderDomain: extractSenderDomainOnly(input.getFromHeaderValue()),
    classification: input.classification,
  })
  if (!diagnostic) return false

  const logFn = options?.logFn ?? console.log
  logFn(formatAmbiguousIntentDiagnosticLog(diagnostic))
  return true
}
