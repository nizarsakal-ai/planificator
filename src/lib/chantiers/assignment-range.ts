/**
 * Plage de jours (AAAA-MM-JJ, jours civils en UTC comme les dates d'affectation stockées) à l'intérieur d'un bloc
 * d'affectation. Sert à supprimer une partie seulement d'un bloc ; le bloc entier reste le choix par défaut.
 */

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 86_400_000

/** Jour civil valide (refuse 2026-02-30, 2026-13-01, formats approximatifs) → instant UTC minuit ; sinon null. */
export function ymdToUtc(value: string): number | null {
  const match = YMD.exec(value)
  if (!match) return null
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const time = Date.UTC(y, m - 1, d)
  const back = new Date(time)
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d ? time : null
}

export type BlockRange =
  | { ok: true; from: string; to: string; days: number }
  | { ok: false; message: string }

/** Plage choisie dans le bloc : dates valides, début ≤ fin, bornes incluses dans le bloc ; jours comptés bornes incluses. */
export function validateBlockRange(block: { from: string; to: string }, range: { from: string; to: string }): BlockRange {
  const blockFrom = ymdToUtc(block.from), blockTo = ymdToUtc(block.to)
  if (blockFrom === null || blockTo === null || blockFrom > blockTo) return { ok: false, message: "Bloc d'affectation invalide." }
  const from = ymdToUtc(range.from), to = ymdToUtc(range.to)
  if (from === null || to === null) return { ok: false, message: "Date invalide." }
  if (from > to) return { ok: false, message: "La date de fin doit être après la date de début." }
  if (from < blockFrom || to > blockTo) return { ok: false, message: "La plage doit rester dans le bloc d'affectation." }
  return { ok: true, from: range.from, to: range.to, days: Math.round((to - from) / DAY_MS) + 1 }
}

/** AAAA-MM-JJ → JJ/MM/AAAA (affichage). */
export const ymdFr = (value: string) => `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}`
