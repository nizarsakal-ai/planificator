/**
 * PLAN-ACQ-CONSULTATIONS-FIX-001 — Corroboration déterministe d’annulation.
 * Catalogue fermé — jamais autorité seule (combiné avec classification + evidence).
 * Le substantif « annulation » / « cancel » seul ne suffit pas.
 */

/** Formulations d’annulation effective / action explicite (FR/EN). */
const CANCEL_POSITIVE = new RegExp(
  [
    // FR — entité + (est / a été) annulé(e)
    String.raw`\b(?:consultation|chantier|projet|commande|demande|offre)\s+(?:est\s+|a\s+[ée]t[ée]\s+)?annul[eée]e?\b`,
    // FR — démonstratif + entité + annulé
    String.raw`\b(?:cette|ce|le|la|notre)\s+(?:consultation|chantier|projet|commande|demande)\s+(?:est\s+|a\s+[ée]t[ée]\s+)?annul`,
    // FR — est / a été / sont annulé(e)(s)
    String.raw`\b(?:est|a\s+[ée]t[ée]|sont|ont\s+[ée]t[ée])\s+annul[eée]e?s?\b`,
    // FR — action : nous/je/on annulons|annule ; merci d'annuler ; veuillez annuler
    String.raw`\b(?:nous|je|on)\s+annul(?:ons|e)\b`,
    String.raw`\bmerci\s+d['’]annuler\b`,
    String.raw`\bveuillez\s+annuler\b`,
    // EN — entity + cancelled
    String.raw`\b(?:consultation|project|order|job|worksite|request)\s+(?:has\s+been\s+|is\s+|was\s+)?cancell?ed\b`,
    // EN — has been / is / was cancelled
    String.raw`\b(?:has\s+been|is|was)\s+cancell?ed\b`,
    // EN — we cancel / we are cancelling ; please cancel
    String.raw`\bwe\s+(?:are\s+)?cancell?(?:ing|ed)?\b`,
    String.raw`\bplease\s+cancel\b`,
  ].join("|"),
  "i"
)

const CANCEL_NEGATION =
  /\b(non[- ]?annul|pas\s+annul|ne\s+(?:pas\s+)?annul|not\s+cancel|uncancel)\b/i

/**
 * Retourne true si le texte contient un signal d’annulation effectif
 * sans négation dominante dans la même fenêtre approximative.
 */
export function corroborateCancellationText(
  subject: string | null | undefined,
  body: string | null | undefined
): boolean {
  const hay = `${subject ?? ""}\n${body ?? ""}`.trim()
  if (!hay) return false
  if (CANCEL_NEGATION.test(hay)) return false
  return CANCEL_POSITIVE.test(hay)
}
