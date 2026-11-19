/**
 * Lot F Planificator V2 : forme canonique et empreinte des éléments reçus par le centre de connecteurs.
 *
 * Implémentation STRICTEMENT LOCALE au lot F (portage sur ab987847, 19/11/2026). La version du 04/11 importait
 * `canonicalJson` et `sha256Hex` du lot D (réserves), absent de cette base : la sémantique est reprise à l'identique,
 * pour que les empreintes et l'idempotence du lot F restent celles de la v6. La forme canonique de la comptabilité
 * (`src/lib/accounting/engine/canonical.ts`) n'est pas réutilisée : elle normalise les chaînes en NFC et relève de la
 * version de chaînage comptable, qui ne doit pas pouvoir changer les empreintes du lot F.
 *
 * - Clés d'objet triées (ordre des points de code), sans espaces ; tableaux dans leur ordre.
 * - Seuls les entiers sûrs sont admis comme nombres (jsonb normalise les décimaux : 1.10 → 1.1).
 * - `undefined` est refusé (jamais d'omission silencieuse).
 */
import { createHash } from "node:crypto"

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isSafeInteger(value)) throw new RangeError("nombre non entier")
    if (value === undefined) throw new TypeError("valeur indéfinie")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const o = value as Record<string, unknown>
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`
}

export const sha256Hex = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex")
