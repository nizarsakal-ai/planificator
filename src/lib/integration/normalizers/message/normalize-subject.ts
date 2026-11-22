/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2A (repris de la PR #42, plan d'implémentation LOT-2 validé le 22/11/2026).
 * Normalisation du `subject` MESSAGE : optionnel, Unicode-safe, borné (SPEC LOT-2 §4.1.1, §11.2).
 *
 * - Invariant : toute entrée `subject` du chemin Mail Shadow (mapper DTO puis normalizer de famille) passe par ici.
 * - Le contrat LOT-1A `normalized-message.ts` reste inchangé (optionnel, sans borne Zod) : la borne est appliquée ici.
 * - Aucun fetch : le `subject` vient du message déjà acquis par le poll. Absence ou vide ⇒ `undefined` (cas valide).
 * - Texte brut d'en-tête : aucun décodage HTML ; caractères de contrôle remplacés par une espace.
 * - Jamais journalisé : la clé `subject` est expurgée par l'API de redaction Integration.
 */

/** Borne du `subject` stocké, en points de code (SPEC LOT-2 §11.2 et §15.4). */
export const SUBJECT_MAX_CODEPOINTS = 512

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g

/** @returns le `subject` normalisé, ou `undefined` s'il est absent ou vide après normalisation. */
export function normalizeSubject(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string") return undefined
  const normalized = raw.normalize("NFC").replace(CONTROL, " ").trim()
  if (normalized.length === 0) return undefined
  const truncated = Array.from(normalized).slice(0, SUBJECT_MAX_CODEPOINTS).join("").trim()
  return truncated.length > 0 ? truncated : undefined
}
