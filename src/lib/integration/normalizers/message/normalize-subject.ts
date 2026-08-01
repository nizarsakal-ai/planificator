/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2A
 * Normalisation subject MESSAGE — Unicode-safe, borné, optionnel.
 *
 * Invariant LOT-2A : toute entrée subject du chemin Mail Shadow
 * (mapper DTO + message-family-normalizer) MUST passer par cette fonction.
 * Le contrat `normalized-message.ts` reste optionnel sans max Zod ;
 * la borne 512 est appliquée exclusivement ici (pas de modification LOT-1A).
 */

import { INBOUND_SOURCE_BOUNDS } from "@/lib/integration/types/inbound-source-rule-type"

/**
 * @returns subject normalisé, ou `undefined` si absent / vide après normalisation.
 */
export function normalizeSubject(
  raw: string | null | undefined
): string | undefined {
  if (raw === null || raw === undefined) return undefined
  if (typeof raw !== "string") return undefined

  const normalized = raw.normalize("NFC").trim()
  if (normalized.length === 0) return undefined

  const truncated = Array.from(normalized)
    .slice(0, INBOUND_SOURCE_BOUNDS.SUBJECT_MAX)
    .join("")

  return truncated.length > 0 ? truncated : undefined
}
