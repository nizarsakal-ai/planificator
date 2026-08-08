/**
 * PLAN-BOOKING-INTENT-DIAG-001 — Instrumentation temporaire (AMBIGU).
 * Activée uniquement si BOOKING_INTENT_DIAGNOSTICS=true.
 * Aucun impact sur le classifieur ni sur les décisions métier.
 * Ne log jamais : corps, email complet, téléphone, adresse postale, nom voyageur.
 */

import type {
  BookingEmailClassification,
  BookingEmailConfidence,
} from "@/lib/booking/booking-email-intent"

const DIAG_LOG_PREFIX = "[booking-intent-diag]"
const SUBJECT_LOG_MAX_LEN = 300

/** Codes structurels émis par le classifieur (evidence). */
const STRUCT_EVIDENCE_CODES = [
  "struct:dates",
  "struct:booking_ref",
  "struct:property",
  "struct:address",
] as const

type GmailHeader = { name?: string | null; value?: string | null }

export type BookingAmbiguousDecisionPath =
  | "partial_structure_ref_without_dates"
  | "lexicon_without_structure"
  | "no_decisive_signal"
  | "unknown_ambiguous"

export type BookingAmbiguousIntentDiagnostic = {
  messageId: string
  companyId: string
  /** Domaine expéditeur uniquement — jamais l'adresse complète. */
  senderDomain: string | null
  subject: string
  evidence: string[]
  structuralScore: number
  confidence: BookingEmailConfidence
  finalDecision: "AMBIGU"
  structuralSignalsPresent: string[]
  missingSignalsPreventingConfirmation: string[]
  decisionPath: BookingAmbiguousDecisionPath
}

export function isBookingIntentDiagnosticsEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.BOOKING_INTENT_DIAGNOSTICS === "true"
}

/**
 * Header From brut (pour extraction domaine uniquement).
 * Ne jamais logger la valeur retournée telle quelle.
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
  // Angle brackets first (RFC-style)
  const angle = fromHeaderValue.match(/<([^<>@\s]+@([^<>@\s]+))>/)
  if (angle?.[2]) {
    const domain = angle[2].trim().toLowerCase()
    return isPlausibleDomain(domain) ? domain : null
  }
  // Bare address (no spaces preferred)
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

export function truncateSubjectForDiagnosticLog(subject: string): string {
  const s = typeof subject === "string" ? subject : ""
  if (s.length <= SUBJECT_LOG_MAX_LEN) return s
  return `${s.slice(0, SUBJECT_LOG_MAX_LEN)}…`
}

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
 * Dérive score / signaux / manques depuis evidence[] uniquement
 * (miroir des règles CONFIRMATION du classifieur, sans reclasser).
 *
 * CONFIRMATION si :
 * - (lexique + structuralScore ≥ 2) OU
 * - (!lexique + ref + dates + score ≥ 3)
 */
export function deriveAmbiguousGapFromEvidence(evidence: string[]): {
  structuralScore: number
  structuralSignalsPresent: string[]
  missingSignalsPreventingConfirmation: string[]
  decisionPath: BookingAmbiguousDecisionPath
} {
  const structuralSignalsPresent = STRUCT_EVIDENCE_CODES.filter((code) =>
    evidence.includes(code)
  )
  const structuralScore = structuralSignalsPresent.length
  const hasLexicon = evidence.includes("pos:confirmation_lexicon")
  const hasDates = evidence.includes("struct:dates")
  const hasRef = evidence.includes("struct:booking_ref")

  const missing: string[] = []

  if (hasLexicon) {
    // Chemin lexique : besoin score ≥ 2
    if (structuralScore < 2) {
      missing.push("need_structural_score_gte_2")
      for (const code of STRUCT_EVIDENCE_CODES) {
        if (!evidence.includes(code)) missing.push(code)
      }
    }
  } else {
    // Chemin structure seule : lexique absent + ref + dates + score ≥ 3
    missing.push("pos:confirmation_lexicon")
    if (!hasRef) missing.push("struct:booking_ref")
    if (!hasDates) missing.push("struct:dates")
    if (structuralScore < 3) {
      missing.push("need_structural_score_gte_3")
      for (const code of STRUCT_EVIDENCE_CODES) {
        if (!evidence.includes(code) && !missing.includes(code)) {
          missing.push(code)
        }
      }
    }
  }

  return {
    structuralScore,
    structuralSignalsPresent: [...structuralSignalsPresent],
    missingSignalsPreventingConfirmation: missing,
    decisionPath: resolveAmbiguousDecisionPath(evidence),
  }
}

export function buildAmbiguousIntentDiagnostic(input: {
  messageId: string
  companyId: string
  senderDomain: string | null
  subject: string
  classification: BookingEmailClassification
}): BookingAmbiguousIntentDiagnostic | null {
  if (input.classification.intent !== "AMBIGU") return null

  const gap = deriveAmbiguousGapFromEvidence(input.classification.evidence)

  return {
    messageId: input.messageId,
    companyId: input.companyId,
    senderDomain: input.senderDomain,
    subject: truncateSubjectForDiagnosticLog(input.subject),
    evidence: [...input.classification.evidence],
    structuralScore: gap.structuralScore,
    confidence: input.classification.confidence,
    finalDecision: "AMBIGU",
    structuralSignalsPresent: gap.structuralSignalsPresent,
    missingSignalsPreventingConfirmation: gap.missingSignalsPreventingConfirmation,
    decisionPath: gap.decisionPath,
  }
}

/** Payload JSON sûr — champs contrôlés uniquement. */
export function formatAmbiguousIntentDiagnosticLog(
  diagnostic: BookingAmbiguousIntentDiagnostic
): string {
  return (
    `${DIAG_LOG_PREFIX} ` +
    JSON.stringify({
      messageId: diagnostic.messageId,
      companyId: diagnostic.companyId,
      senderDomain: diagnostic.senderDomain,
      subject: diagnostic.subject,
      evidence: diagnostic.evidence,
      structuralScore: diagnostic.structuralScore,
      confidence: diagnostic.confidence,
      finalDecision: diagnostic.finalDecision,
      structuralSignalsPresent: diagnostic.structuralSignalsPresent,
      missingSignalsPreventingConfirmation:
        diagnostic.missingSignalsPreventingConfirmation,
      decisionPath: diagnostic.decisionPath,
    })
  )
}

/**
 * Log conditionnel. Retourne true si un log a été émis.
 * `logFn` injectable pour tests.
 */
export function maybeLogAmbiguousIntentDiagnostic(
  input: {
    messageId: string
    companyId: string
    fromHeaderValue: string
    subject: string
    classification: BookingEmailClassification
  },
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
    senderDomain: extractSenderDomainOnly(input.fromHeaderValue),
    subject: input.subject,
    classification: input.classification,
  })
  if (!diagnostic) return false

  const logFn = options?.logFn ?? console.log
  logFn(formatAmbiguousIntentDiagnosticLog(diagnostic))
  return true
}
