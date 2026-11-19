/**
 * Lot G Planificator V2 : forme canonique et empreinte du Document Studio (versions publiées, instantanés générés).
 *
 * Implémentation STRICTEMENT LOCALE au lot G (portage sur ef36578f, 19/11/2026). La version du 04/11 importait
 * `canonicalJson` et `sha256Hex` du lot D (réserves), absent de cette base : la sémantique est reprise à l'identique, pour
 * que les empreintes du lot G restent celles de la v6 (même primitive que le portage du lot F, sans dépendance croisée).
 * La forme canonique de la comptabilité (`src/lib/accounting/engine/canonical.ts`) n'est pas réutilisée : elle normalise les
 * chaînes en NFC et relève de la version de chaînage comptable.
 *
 * - Clés d'objet triées (ordre des unités de code), sans espaces ; tableaux dans leur ordre.
 * - Seuls les entiers sûrs sont admis comme nombres (jsonb normalise les décimaux : 1.10 → 1.1).
 * - `undefined` est refusé (jamais d'omission silencieuse).
 */
import { createHash } from "node:crypto"

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isSafeInteger(value)) throw new RangeError("nombre non entier dans l'instantané")
    if (value === undefined) throw new TypeError("valeur indéfinie")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const o = value as Record<string, unknown>
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`
}

export const sha256Hex = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex")
