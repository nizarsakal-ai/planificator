// SPEC-BANK-VERIF-001 — IBAN : normalisation, contrôle de structure (ISO 13616, modulo 97) et masquage. Pur.
// Un IBAN bien formé ne prouve NI l'existence du compte NI son titulaire : seul un prestataire peut le confirmer.

/** Longueurs par pays (SEPA et pays courants). Pays absent ⇒ refus (fail-closed). */
const IBAN_LENGTH: Record<string, number> = {
  FR: 27, MC: 27, BE: 16, DE: 22, ES: 24, IT: 27, LU: 20, NL: 18, PT: 25, CH: 21, GB: 22, IE: 22, AT: 20, DK: 18, FI: 18, SE: 24, NO: 15, PL: 28, GR: 27, CZ: 24, HU: 28, RO: 24, BG: 22, HR: 21, SI: 19, SK: 24, EE: 20, LV: 21, LT: 20, MT: 31, CY: 28, IS: 26, LI: 21, SM: 27, AD: 24,
}

export function normalizeIban(raw: string): string {
  return raw.replace(/[\s  .-]/g, "").toUpperCase()
}

export function isValidIban(raw: string): boolean {
  const iban = normalizeIban(raw)
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false
  if (IBAN_LENGTH[iban.slice(0, 2)] !== iban.length) return false
  // Modulo 97 par blocs (pas de BigInt nécessaire) : lettres → 10..35, 4 premiers caractères déplacés à la fin.
  const rearranged = iban.slice(4) + iban.slice(0, 4)
  let remainder = 0
  for (const ch of rearranged) {
    const v = ch >= "A" ? (ch.charCodeAt(0) - 55).toString() : ch
    for (const digit of v) remainder = (remainder * 10 + Number(digit)) % 97
  }
  return remainder === 1
}

/** « FR76 •••• •••• 0189 » : jamais d'IBAN complet dans les journaux ni les messages. */
export function maskIban(raw: string): string {
  const iban = normalizeIban(raw)
  return iban.length < 8 ? "••••" : `${iban.slice(0, 4)} •••• •••• ${iban.slice(-4)}`
}
