import { businessDay } from "@/lib/time/business-day"
// Libellés partagés des écrans Comptabilité (pur, sans dépendance serveur).
const dateFrFmt = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" })

/** Modules réservés (SPEC-ACC-A2 §6) : affichés « à venir », non cliquables. Constante hors module client pour être lisible côté serveur. */
export const UPCOMING_MODULES: readonly string[] = [] // Lot C5 : Export FEC, TVA, Banque et rapprochement, Écritures depuis les factures livrés.

export const FISCAL_YEAR_STATUS: Record<string, string> = { OPEN: "Ouvert", CLOSING: "En clôture", CLOSED: "Clôturé" }
export const ENTRY_STATUS: Record<string, string> = { DRAFT: "Brouillon", VALIDATED: "Validée" }

export function fiscalYearLabel(y: { startDate: Date; endDate: Date; status: string }): string {
  return `${dateFrFmt.format(y.startDate)} → ${dateFrFmt.format(y.endDate)} (${FISCAL_YEAR_STATUS[y.status] ?? y.status})`
}

/** Paramètre d'URL facultatif : chaîne courte ou undefined (les ids sont ensuite filtrés par société côté requête). */
export function searchParam(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value
  if (typeof v !== "string") return undefined
  const t = v.trim()
  return t.length > 0 && t.length <= 64 ? t : undefined
}

/** Exercice par défaut : celui demandé s'il existe, sinon l'ouvert, sinon le plus récent. */
export function pickFiscalYear<T extends { id: string; status: string }>(years: readonly T[], requested?: string): T | undefined {
  return years.find((y) => y.id === requested) ?? years.find((y) => y.status === "OPEN") ?? years[0]
}

/** Jour (AAAA-MM-JJ, UTC) par défaut pour une saisie dans l'exercice : aujourd'hui s'il est dans l'exercice, sinon son début. */
export function defaultDayInYear(year: { startDate: Date; endDate: Date }, now: Date = new Date()): string {
  const today = businessDay(now).toISOString().slice(0, 10) // S3 : jour civil Europe/Paris
  const start = year.startDate.toISOString().slice(0, 10)
  const end = year.endDate.toISOString().slice(0, 10)
  return today >= start && today <= end ? today : start
}

/** Exercice contenant aujourd'hui (comparaison par jour), sinon le premier de la liste. */
export function yearContainingToday<T extends { startDate: Date; endDate: Date }>(years: readonly T[], now: Date = new Date()): T | undefined {
  return years.find((y) => defaultDayInYear(y, now) === businessDay(now).toISOString().slice(0, 10)) ?? years[0]
}
