/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2D
 * Calcul PUR de la parité legacy L1 ↔ Router (SPEC LOT-2 §14.4 à §14.6 ; plan I6 « décision contre décision »).
 *
 * - Baseline unique : L1 = résultat de `registerIncomingMessage` (DRAFT_CREATED → ADMIT, REJECTED → REJECT).
 * - Table §14.5 appliquée telle quelle ; AMBIGUOUS_SOURCE / ERROR Router ⇒ PARITY_UNCOMPARABLE.
 * - Codes EXPLAINED_* (§14.6) = annotations : ils ne remplacent jamais l'outcome de parité.
 *   `EXPLAINED_MATCH_NO_DRAFT` est posé sur toute observation où le Router dit MATCH (aucun brouillon
 *   Platform n'existe en LOT-2) ; il n'explique pas à lui seul une divergence.
 * Aucune I/O, aucune valeur métier : uniquement des classes et des codes.
 */
import type { RoutingOutcome } from "@/lib/integration/types/routing-outcome"

export const PARITY_BASELINE_CODE = "L1_REGISTER_INCOMING_MESSAGE" as const

export const LEGACY_OUTCOME_CLASSES = { ADMIT: "ADMIT", REJECT: "REJECT", UNKNOWN: "UNKNOWN" } as const
export type LegacyOutcomeClass = (typeof LEGACY_OUTCOME_CLASSES)[keyof typeof LEGACY_OUTCOME_CLASSES]

export const PARITY_OUTCOMES = {
  MATCH: "PARITY_MATCH",
  REJECT: "PARITY_REJECT",
  LEGACY_ONLY: "PARITY_LEGACY_ONLY",
  ROUTER_ONLY: "PARITY_ROUTER_ONLY",
  UNCOMPARABLE: "PARITY_UNCOMPARABLE",
  ERROR: "PARITY_ERROR",
} as const
export type ParityOutcome = (typeof PARITY_OUTCOMES)[keyof typeof PARITY_OUTCOMES]

export const EXPLAINED_CODES = {
  MATCH_NO_DRAFT: "EXPLAINED_MATCH_NO_DRAFT",
  SUBJECT_ABSENT: "EXPLAINED_SUBJECT_ABSENT",
  BODY_UNAVAILABLE: "EXPLAINED_BODY_UNAVAILABLE",
  QUALIFIER_GAP: "EXPLAINED_QUALIFIER_GAP",
  CONFIG_NOT_SEEDED: "EXPLAINED_CONFIG_NOT_SEEDED",
} as const
export type ExplainedCode = (typeof EXPLAINED_CODES)[keyof typeof EXPLAINED_CODES]

/** Résultat L1 → classe de parité. Toute autre valeur (inconnue, erreur) ⇒ UNKNOWN. */
export function classifyLegacyOutcome(outcome: string | null | undefined): LegacyOutcomeClass {
  if (outcome === "DRAFT_CREATED") return LEGACY_OUTCOME_CLASSES.ADMIT
  if (outcome === "REJECTED") return LEGACY_OUTCOME_CLASSES.REJECT
  return LEGACY_OUTCOME_CLASSES.UNKNOWN
}

export interface ParityInput {
  legacy: LegacyOutcomeClass
  /** null : le Router n'a pas produit de décision (budget, erreur technique de comparaison). */
  router: Exclude<RoutingOutcome, "DUPLICATE"> | null
  routerReasonCode?: string
  diagnostics?: {
    qualifierGap: boolean
    subjectGap?: boolean
    bodyGap?: boolean
    subjectKeywordRuleActive: boolean
    bodyKeywordRuleActive: boolean
    subjectPresent: boolean
    bodyAvailable: boolean
  }
  /** Vrai si la comparaison elle-même a échoué techniquement. */
  comparisonFailed?: boolean
}

export interface ParityResult {
  parityOutcome: ParityOutcome
  explainedCodes: ExplainedCode[]
}

export function computeParity(input: ParityInput): ParityResult {
  const explained = new Set<ExplainedCode>()
  const d = input.diagnostics
  if (input.router === "MATCH") explained.add(EXPLAINED_CODES.MATCH_NO_DRAFT)
  if (input.routerReasonCode === "NO_ENABLED_SOURCE" && input.legacy === "ADMIT") explained.add(EXPLAINED_CODES.CONFIG_NOT_SEEDED)
  // Explications d'un admis legacy manqué par le Router : seulement si l'écart vient d'une Source dont l'identité
  // a matché (revue indépendante du 24/11, point 1). Jamais pour un ROUTER_ONLY : ni l'objet absent ni le corps
  // indisponible ne peuvent produire un MATCH en trop.
  const legacyMissedByRouter = input.legacy === "ADMIT" && input.router !== null && input.router !== "MATCH"
  if (legacyMissedByRouter && d?.subjectGap) explained.add(EXPLAINED_CODES.SUBJECT_ABSENT)
  if (legacyMissedByRouter && d?.bodyGap) explained.add(EXPLAINED_CODES.BODY_UNAVAILABLE)
  if (legacyMissedByRouter && d?.qualifierGap) explained.add(EXPLAINED_CODES.QUALIFIER_GAP)
  const explainedCodes = [...explained].sort()

  if (input.comparisonFailed) return { parityOutcome: PARITY_OUTCOMES.ERROR, explainedCodes }
  if (input.legacy === "UNKNOWN" || input.router === null) return { parityOutcome: PARITY_OUTCOMES.UNCOMPARABLE, explainedCodes }
  if (input.router === "AMBIGUOUS_SOURCE" || input.router === "ERROR") return { parityOutcome: PARITY_OUTCOMES.UNCOMPARABLE, explainedCodes }
  const routerAdmits = input.router === "MATCH"
  if (input.legacy === "ADMIT") {
    return { parityOutcome: routerAdmits ? PARITY_OUTCOMES.MATCH : PARITY_OUTCOMES.LEGACY_ONLY, explainedCodes }
  }
  return { parityOutcome: routerAdmits ? PARITY_OUTCOMES.ROUTER_ONLY : PARITY_OUTCOMES.REJECT, explainedCodes }
}

/**
 * Divergence non expliquée (critère « = 0 » avant LOT-3, §14.8) : LEGACY_ONLY ou ROUTER_ONLY sans aucun code
 * EXPLAINED_* autre que l'annotation EXPLAINED_MATCH_NO_DRAFT.
 */
export function isUnexplainedDivergence(r: ParityResult): boolean {
  if (r.parityOutcome !== PARITY_OUTCOMES.LEGACY_ONLY && r.parityOutcome !== PARITY_OUTCOMES.ROUTER_ONLY) return false
  return !r.explainedCodes.some((c) => c !== EXPLAINED_CODES.MATCH_NO_DRAFT)
}
