/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1A / STEP-2
 * Handle logique opaque `credentialsRef` (SECURITY-SPEC).
 *
 * Non secret : aucune résolution, aucun déchiffrement, aucun backend ici.
 * Toute résolution MUST toujours combiner ce handle avec `companyId` + `connectionId`
 * (AuthZ / AAD / isolation tenant) — jamais le handle seul.
 */

import { z } from "zod"

declare const credentialsRefBrand: unique symbol

export type CredentialsRef = string & {
  readonly [credentialsRefBrand]: true
}

export const credentialsRefSchema = z
  .string()
  .min(1)
  .transform((value): CredentialsRef => value as CredentialsRef)

export type CredentialsRefInput = z.input<typeof credentialsRefSchema>
