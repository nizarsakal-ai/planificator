/**
 * PLAN-BOOKING-PARSER-003 LOT 1 — Classification d’intent emails Booking (déterministe).
 * Aucune PII loguée ici ; evidence = codes de motifs uniquement.
 */

export type BookingEmailIntent =
  | "CONFIRMATION"
  | "MESSAGE_ETABLISSEMENT"
  | "RECU"
  | "ANNULATION"
  | "AUTRE_PROUVE"
  | "AMBIGU"

export type BookingEmailConfidence = "high" | "medium" | "low"

export type BookingEmailClassification = {
  intent: BookingEmailIntent
  confidence: BookingEmailConfidence
  evidence: string[]
}

/** Codes lifecycle stables — hors confirmation. */
export const BOOKING_INTENT_IGNORE_CODES = {
  MESSAGE_ETABLISSEMENT: "IGNORED_BOOKING_HOST_MESSAGE",
  RECU: "IGNORED_BOOKING_RECEIPT",
  ANNULATION: "IGNORED_BOOKING_CANCELLATION",
  AUTRE_PROUVE: "IGNORED_BOOKING_NON_CONFIRMATION",
  /** Retryable borné (puis permanent au plafond) — jamais de pending. */
  AMBIGU: "BOOKING_EMAIL_INTENT_AMBIGUOUS",
} as const

export type BookingIntentIgnoreCode =
  (typeof BOOKING_INTENT_IGNORE_CODES)[keyof typeof BOOKING_INTENT_IGNORE_CODES]

export type BookingIntentScanStatsKey =
  | "confirmationCount"
  | "hostMessageIgnoredCount"
  | "receiptIgnoredCount"
  | "cancellationIgnoredCount"
  | "otherIgnoredCount"
  | "ambiguousCount"

export type BookingIntentScanDisposition =
  | {
      action: "PROCEED_CONFIRMATION"
      classification: BookingEmailClassification
      statsKey: "confirmationCount"
    }
  | {
      action: "PERMANENT_IGNORE"
      classification: BookingEmailClassification
      code: Exclude<BookingIntentIgnoreCode, "BOOKING_EMAIL_INTENT_AMBIGUOUS">
      statsKey: Exclude<
        BookingIntentScanStatsKey,
        "confirmationCount" | "ambiguousCount"
      >
      message: string
    }
  | {
      action: "RETRYABLE_AMBIGUOUS"
      classification: BookingEmailClassification
      code: "BOOKING_EMAIL_INTENT_AMBIGUOUS"
      statsKey: "ambiguousCount"
      message: string
    }

type GmailHeader = { name?: string | null; value?: string | null }

/**
 * Subject Gmail réel depuis payload.headers (format=full).
 * Jamais inféré depuis le snippet.
 */
export function extractGmailSubject(
  payload: { headers?: GmailHeader[] | null } | null | undefined
): string {
  const headers = payload?.headers
  if (!Array.isArray(headers)) return ""
  for (const h of headers) {
    if (typeof h?.name === "string" && h.name.toLowerCase() === "subject") {
      return typeof h.value === "string" ? h.value.trim() : ""
    }
  }
  return ""
}

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
}

function pushEvidence(evidence: string[], code: string): void {
  if (!evidence.includes(code)) evidence.push(code)
}

function anyMatch(
  text: string,
  patterns: RegExp[],
  evidence: string[],
  code: string
): boolean {
  for (const p of patterns) {
    if (p.test(text)) {
      pushEvidence(evidence, code)
      return true
    }
  }
  return false
}

/**
 * Message hôte / établissement annoncé dans le SUJET (ignore immédiat).
 * Ne s’applique pas au corps.
 */
const HOST_SUBJECT_PATTERNS: RegExp[] = [
  /\bnouveau message\b/,
  /\byou have a new message\b/,
  /\bnew message from (?:the property|(?:your )?host)\b/,
]

/**
 * Fenêtre d’ouverture du corps normalisé (après trim / collapse espaces).
 * Un match HOST primaire est « ouverture » si son index de début est strictement
 * inférieur à cette borne — la phrase entière est cherchée dans le corps complet
 * (pas de troncature avant matching).
 * Assez large pour l’annonce FR/EN « vous avez un nouveau message… »,
 * trop courte pour un CTA après le bloc structurel Booking typique.
 */
export const HOST_BODY_OPENING_MAX_CHARS = 160

/**
 * HOST primaire — annonce explicite dont le début tombe dans l’ouverture du corps.
 * Jamais surpassable par une confirmation forte (sujet + ref + dates).
 */
const HOST_BODY_OPENING_PRIMARY_PATTERNS: RegExp[] = [
  /vous avez un nouveau message de l['’]?etablissement/,
  /nouveau message de l['’]?etablissement/,
  /you have a new message from the property/,
  /you have a new message from (?:your )?host/,
  /new message from the property/,
]

/**
 * HOST secondaire / CTA — plus loin dans le corps d’une confirmation.
 * Surpassable uniquement si sujet fort + ref + dates.
 */
const HOST_BODY_SECONDARY_CTA_PATTERNS: RegExp[] = [
  /nouveau message de l['’]?etablissement/,
  // CTA « voir les messages » : exiger « nouveau message » à proximité.
  /nouveau message[\s\S]{0,80}voir les messages/,
  /new message from the property/,
  /new message[\s\S]{0,80}view messages/,
  /you have a new message from the property/,
  /you have a new message from (?:your )?host/,
]

/**
 * Signal explicite de confirmation dans le SUJET seul (borné, ne traverse pas le corps).
 * « Merci ! Votre réservation » sans « est confirmée » / équivalent → insuffisant.
 */
const STRONG_SUBJECT_CONFIRMATION_PATTERNS: RegExp[] = [
  /confirmation de reservation/,
  /reservation confirmee/,
  /votre reservation .{1,120}est confirmee/,
  /votre appartement est confirme/,
  /voici votre confirmation/,
  /confirmation booking/,
  /booking confirmation/,
  /your booking is confirmed/,
  /your reservation .{1,120}is confirmed/,
  /reservation confirmed/,
  /booking\.com confirmation/,
]

const CANCELLATION_PATTERNS: RegExp[] = [
  /reservation annulee/,
  /votre reservation a ete annulee/,
  /annulation de (?:votre )?reservation/,
  /booking cancelled/,
  /booking canceled/,
  /your booking has been cancelled/,
  /your booking has been canceled/,
  /cancellation confirmation/,
  /reservation cancelled/,
]

/**
 * Intent principal RECU — phrases d’ouverture / sujet de reçu réel.
 * Ne doit PAS matcher un CTA footer dans une confirmation
 * (« Download your Booking invoice », « Payment invoice available », …).
 */
const RECEIPT_PRIMARY_PATTERNS: RegExp[] = [
  /voici votre recu/,
  /votre recu booking/,
  /here(?:'| i)?s your receipt/,
  /here(?:'| i)?s your invoice/,
  /voici votre facture/,
  // Ancré début de ligne/phrase — évite « télécharger votre facture booking » (CTA)
  /(?:^|[\n.!?])\s*votre facture booking/,
  /\brecu de paiement\b/,
  /\byour booking\.com receipt\b/,
  /\bbooking\.com receipt\b/,
]

/** Mentions secondaires / CTA — evidence seulement, jamais intent RECU seuls. */
const RECEIPT_SECONDARY_CTA_PATTERNS: RegExp[] = [
  /download your booking invoice/,
  /download your payment receipt/,
  /download your (?:booking )?invoice/,
  /payment invoice available/,
  /invoice available(?: for download)?/,
  /telecharger (?:votre )?facture(?: booking)?/,
  /telecharger la facture/,
  /booking invoice/,
  /payment invoice/,
  /payment receipt/,
]

const RECEIPT_SUBJECT_PATTERNS: RegExp[] = [
  /\breceipt\b/,
  /\binvoice\b/,
  /\bfacture\b/,
  /\brecu\b/,
]

const PAYMENT_CONTENT_PATTERNS: RegExp[] = [
  /\bmontant\b/,
  /\bamount\b/,
  /\btotal\b/,
  /\bpayment\b/,
  /\bpaiement\b/,
  /\byou paid\b/,
  /vous avez paye/,
  /\bpaid\b/,
]

const AUTRE_PATTERNS: RegExp[] = [
  /verification d['’]?identite/,
  /identity verification/,
  /verify your identity/,
  /\bpromotion\b/,
  /\bpromotional\b/,
  /offre speciale/,
  /special offer/,
  /\bmarketing\b/,
  /newsletter/,
]

/** Lexique confirmation (combined) — historique ; insuffisant seul. Pas de « merci…réservation » nu. */
const CONFIRMATION_LEXICON: RegExp[] = [
  /confirmation de reservation/,
  /reservation confirmee/,
  /votre reservation .{1,120}est confirmee/,
  /votre appartement est confirme/,
  /voici votre confirmation/,
  /confirmation booking/,
  /booking confirmation/,
  /your booking is confirmed/,
  /your reservation .{1,120}is confirmed/,
  /reservation confirmed/,
  /booking\.com confirmation/,
]

const STRUCT_DATES: RegExp[] = [
  /\bcheck[\s-]?in\b/,
  /\bcheck[\s-]?out\b/,
  /\barrivee\b/,
  /\bdepart\b/,
  /\bdu\s+\d{1,2}.+\bau\s+\d{1,2}/,
  /\b\d{4}-\d{2}-\d{2}\b.*\b\d{4}-\d{2}-\d{2}\b/,
]

const STRUCT_REF: RegExp[] = [
  /numero de (?:confirmation|reservation)/,
  /confirmation number/,
  /booking number/,
  /reservation (?:number|id)/,
  /\bref(?:erence)?\s*[:#]\s*[a-z0-9-]+/i,
]

const STRUCT_PROPERTY: RegExp[] = [
  /\betablissement\b/,
  /\bproperty\b/,
  /\bappartement\b/,
  /\baccommodation\b/,
  /\blogement\b/,
]

const STRUCT_ADDRESS: RegExp[] = [
  /\badresse\b/,
  /\baddress\b/,
  /\b\d{1,4}\s+(?:rue|avenue|bd|boulevard|chemin|place|route)\b/,
  /\bstreet\b/,
]

function structuralScore(
  text: string,
  evidence: string[]
): { score: number; hasDates: boolean; hasRef: boolean } {
  let score = 0
  const hasDates = anyMatch(text, STRUCT_DATES, evidence, "struct:dates")
  if (hasDates) score++
  const hasRef = anyMatch(text, STRUCT_REF, evidence, "struct:booking_ref")
  if (hasRef) score++
  if (anyMatch(text, STRUCT_PROPERTY, evidence, "struct:property")) score++
  if (anyMatch(text, STRUCT_ADDRESS, evidence, "struct:address")) score++
  return { score, hasDates, hasRef }
}

function isPrimaryReceiptIntent(
  subject: string,
  body: string,
  combined: string,
  evidence: string[]
): boolean {
  if (anyMatch(combined, RECEIPT_PRIMARY_PATTERNS, evidence, "neg:receipt_primary")) {
    return true
  }
  const subjectLooksReceipt = anyMatch(
    subject,
    RECEIPT_SUBJECT_PATTERNS,
    evidence,
    "neg:receipt_subject"
  )
  if (!subjectLooksReceipt) return false
  // Sujet reçu/facture + contenu paiement → intent principal RECU
  // (même avec ref/dates/adresse historiques de la réservation).
  if (anyMatch(body, PAYMENT_CONTENT_PATTERNS, evidence, "neg:receipt_payment")) {
    return true
  }
  return false
}

function noteSecondaryReceiptCtas(combined: string, evidence: string[]): void {
  anyMatch(
    combined,
    RECEIPT_SECONDARY_CTA_PATTERNS,
    evidence,
    "weak:receipt_cta"
  )
}

/**
 * Index de début du premier match parmi `patterns` dans `text` (corps complet).
 * Ne tronque pas le texte. Clone chaque regex pour éviter lastIndex partagé.
 * Retourne -1 si aucun match.
 */
function firstPatternMatchStartIndex(
  text: string,
  patterns: RegExp[]
): number {
  let earliest = -1
  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, pattern.flags)
    const match = re.exec(text)
    if (match && (earliest < 0 || match.index < earliest)) {
      earliest = match.index
    }
  }
  return earliest
}

/**
 * Index de début du premier motif HOST primaire dans un corps déjà normalisé.
 * Exposé pour tests de borne (pas de troncature avant matching).
 */
export function hostBodyPrimaryMatchStartIndex(normalizedBody: string): number {
  return firstPatternMatchStartIndex(
    normalizedBody,
    HOST_BODY_OPENING_PRIMARY_PATTERNS
  )
}

/**
 * HOST corps primaire si le premier motif primaire commence dans l’ouverture
 * (`index < HOST_BODY_OPENING_MAX_CHARS`), même si la phrase déborde de la borne.
 */
function hasHostBodyOpeningPrimary(body: string, evidence: string[]): boolean {
  const start = hostBodyPrimaryMatchStartIndex(body)
  if (start >= 0 && start < HOST_BODY_OPENING_MAX_CHARS) {
    pushEvidence(evidence, "neg:host_message")
    return true
  }
  return false
}

function hasHostBodySecondaryCta(body: string, evidence: string[]): boolean {
  return anyMatch(
    body,
    HOST_BODY_SECONDARY_CTA_PATTERNS,
    evidence,
    "weak:host_cta"
  )
}

/**
 * Confirmation forte pour surpasser un CTA HOST secondaire du corps uniquement :
 * signal explicite dans le SUJET + ref Booking + dates.
 * Ne s’applique jamais à une ouverture HOST primaire.
 */
function canOverrideSecondaryHostCtaWithStrongConfirmation(
  hasStrongSubjectConfirmation: boolean,
  hasRef: boolean,
  hasDates: boolean
): boolean {
  return hasStrongSubjectConfirmation && hasRef && hasDates
}

/** Chemin historique CONFIRMATION (hors override HOST corps). */
function isHistoricalConfirmation(
  hasLexicon: boolean,
  hasRef: boolean,
  hasDates: boolean,
  score: number
): boolean {
  if (hasLexicon && score >= 2) return true
  if (!hasLexicon && hasRef && hasDates && score >= 3) return true
  return false
}

/**
 * Classification déterministe FR/EN.
 * Ordre :
 *   host SUJET → cancel → reçu principal → autre →
 *   host ouverture CORPS (primaire, non overridable) →
 *   (CTA HOST secondaire noté) → override confirmation forte (sujet+ref+dates) →
 *   CTA HOST secondaire → confirmation historique → AMBIGU.
 */
export function classifyBookingEmailIntent(input: {
  subject: string
  bodyText: string
}): BookingEmailClassification {
  const evidence: string[] = []
  const subject = normalizeForMatch(input.subject ?? "")
  const body = normalizeForMatch(input.bodyText ?? "")
  const combined = `${subject}\n${body}`

  // A) Message hôte explicite dans le sujet → ignore immédiat
  if (anyMatch(subject, HOST_SUBJECT_PATTERNS, evidence, "neg:host_message")) {
    return {
      intent: "MESSAGE_ETABLISSEMENT",
      confidence: "high",
      evidence,
    }
  }

  // B) Annulation / reçu / autre
  if (anyMatch(combined, CANCELLATION_PATTERNS, evidence, "neg:cancellation")) {
    return {
      intent: "ANNULATION",
      confidence: "high",
      evidence,
    }
  }

  noteSecondaryReceiptCtas(combined, evidence)

  if (isPrimaryReceiptIntent(subject, body, combined, evidence)) {
    return {
      intent: "RECU",
      confidence: "high",
      evidence,
    }
  }

  if (anyMatch(combined, AUTRE_PATTERNS, evidence, "neg:other")) {
    return {
      intent: "AUTRE_PROUVE",
      confidence: "high",
      evidence,
    }
  }

  // D1) Ouverture de corps HOST primaire — non overridable
  if (hasHostBodyOpeningPrimary(body, evidence)) {
    return {
      intent: "MESSAGE_ETABLISSEMENT",
      confidence: "high",
      evidence,
    }
  }

  // D2) CTA HOST secondaire dans le corps
  const bodyHasSecondaryHostCta = hasHostBodySecondaryCta(body, evidence)

  // C) Confirmation forte : sujet seul + structure ref/dates → dépasse CTA secondaire seulement
  const hasStrongSubjectConfirmation = anyMatch(
    subject,
    STRONG_SUBJECT_CONFIRMATION_PATTERNS,
    evidence,
    "pos:strong_subject_confirmation"
  )

  const { score, hasDates, hasRef } = structuralScore(combined, evidence)

  if (
    canOverrideSecondaryHostCtaWithStrongConfirmation(
      hasStrongSubjectConfirmation,
      hasRef,
      hasDates
    )
  ) {
    return {
      intent: "CONFIRMATION",
      confidence: score >= 3 ? "high" : "medium",
      evidence,
    }
  }

  if (bodyHasSecondaryHostCta) {
    pushEvidence(evidence, "neg:host_message")
    return {
      intent: "MESSAGE_ETABLISSEMENT",
      confidence: "high",
      evidence,
    }
  }

  // E) Confirmation historique (lexique combined + structure, ou structure forte)
  const hasLexicon = anyMatch(
    combined,
    CONFIRMATION_LEXICON,
    evidence,
    "pos:confirmation_lexicon"
  )
  if (/\bconfirmation\b/.test(subject) || /\bconfirmation\b/.test(body)) {
    pushEvidence(evidence, "weak:confirmation_word")
  }

  if (isHistoricalConfirmation(hasLexicon, hasRef, hasDates, score)) {
    return {
      intent: "CONFIRMATION",
      confidence: hasLexicon && score >= 3 ? "high" : "medium",
      evidence,
    }
  }

  if (hasRef && !hasDates && score < 3) {
    pushEvidence(evidence, "ambig:partial_structure")
    return {
      intent: "AMBIGU",
      confidence: "low",
      evidence,
    }
  }

  if (hasLexicon && score < 2) {
    pushEvidence(evidence, "ambig:lexicon_without_structure")
    return {
      intent: "AMBIGU",
      confidence: "low",
      evidence,
    }
  }

  pushEvidence(evidence, "ambig:no_decisive_signal")
  return {
    intent: "AMBIGU",
    confidence: "low",
    evidence,
  }
}

/**
 * Disposition scan LOT 1 / R2.
 * AMBIGU → retry borné (markFailure) ; hors-confirmation prouvée → permanent.
 */
export function resolveBookingIntentScanDisposition(
  classification: BookingEmailClassification
): BookingIntentScanDisposition {
  switch (classification.intent) {
    case "CONFIRMATION":
      return {
        action: "PROCEED_CONFIRMATION",
        classification,
        statsKey: "confirmationCount",
      }
    case "MESSAGE_ETABLISSEMENT":
      return {
        action: "PERMANENT_IGNORE",
        classification,
        code: BOOKING_INTENT_IGNORE_CODES.MESSAGE_ETABLISSEMENT,
        statsKey: "hostMessageIgnoredCount",
        message: "Email Booking : message établissement (hors confirmation)",
      }
    case "RECU":
      return {
        action: "PERMANENT_IGNORE",
        classification,
        code: BOOKING_INTENT_IGNORE_CODES.RECU,
        statsKey: "receiptIgnoredCount",
        message: "Email Booking : reçu / facture (hors confirmation)",
      }
    case "ANNULATION":
      return {
        action: "PERMANENT_IGNORE",
        classification,
        code: BOOKING_INTENT_IGNORE_CODES.ANNULATION,
        statsKey: "cancellationIgnoredCount",
        message: "Email Booking : annulation ignorée par le scan Gmail",
      }
    case "AUTRE_PROUVE":
      return {
        action: "PERMANENT_IGNORE",
        classification,
        code: BOOKING_INTENT_IGNORE_CODES.AUTRE_PROUVE,
        statsKey: "otherIgnoredCount",
        message: "Email Booking : hors confirmation initiale",
      }
    case "AMBIGU":
      return {
        action: "RETRYABLE_AMBIGUOUS",
        classification,
        code: BOOKING_INTENT_IGNORE_CODES.AMBIGU,
        statsKey: "ambiguousCount",
        message:
          "Email Booking : intent ambigu — aucun pending (retry borné)",
      }
  }
}
