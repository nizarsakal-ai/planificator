/**
 * Lot H Planificator V2 : pré-paie — règles PURES.
 *
 * Une période = un mois civil. Variables par salarié :
 * - heures travaillées : somme des pointages COMPLETS du mois (sortie après entrée, 16 h au plus), en minutes ;
 * - jours travaillés : jours ayant un pointage complet et valide (un seul pointage par salarié et par jour : unicité
 *   `(employeeId, date)` du modèle Timeclock existant) ;
 * - jours d'absence VALIDÉE par type, en jours ouvrés du lundi au vendredi compris dans le mois (jours fériés NON
 *   déduits : limite documentée, à qualifier) ;
 * - primes et frais saisis à la main (centimes).
 * Contrôles bloquants pour la clôture : pointage incomplet, pointage incohérent, absence en attente de décision.
 * Contrôle signalé (non bloquant) : pointage un jour d'absence validée.
 * AUCUN calcul de salaire ni de cotisation : ce module ne produit que des variables et un export.
 */
import { formatDay, parseDay } from "@/lib/equipment/equipment.core"

export type AbsenceKind = "VACATION" | "SICK" | "UNPAID" | "TRAINING" | "OTHER"
export const ABSENCE_KINDS: readonly AbsenceKind[] = ["VACATION", "SICK", "UNPAID", "TRAINING", "OTHER"]
export const ABSENCE_LABEL: Record<AbsenceKind, string> = { VACATION: "Congés payés", SICK: "Maladie", UNPAID: "Sans solde", TRAINING: "Formation", OTHER: "Autre" }
export type VariableKind = "BONUS" | "EXPENSE"
export const VARIABLE_LABEL: Record<VariableKind, string> = { BONUS: "Prime", EXPENSE: "Frais" }
export const MAX_WORK_MINUTES_PER_DAY = 16 * 60
// Portage sur 90ae644 : aucun littéral BigInt (cible TypeScript ES2017), valeurs construites par BigInt(...).
const B0 = BigInt(0), B100 = BigInt(100)
export const MAX_VARIABLE_CENTS = BigInt(1_000_000_000) // 10 000 000,00 €

export const PREPAY_ERRORS = {
  notFound: "Élément introuvable.",
  period: "Période invalide (mois de 2000 à 2100, au plus le mois en cours).",
  exists: "Cette période est déjà ouverte.",
  closed: "Période clôturée : elle n'est plus modifiable.",
  blocking: (n: number) => `Clôture impossible : ${n} contrôle(s) bloquant(s) à résoudre (pointages, absences en attente).`,
  kind: "Type de variable invalide.",
  amount: "Montant invalide (positif, au plus 10 000 000,00 €).",
  label: "Libellé obligatoire (2 à 120 caractères).",
  employee: "Salarié introuvable ou inactif.",
  // Portage sur 90ae644 : issue métier d'une clôture concurrente d'une saisie, après une relance automatique.
  concurrent: "Clôture interrompue par une saisie simultanée : vérifiez les variables puis relancez la clôture.",
} as const

export type Plan<T> = { ok: true; value: T } | { ok: false; error: string }
const ko = (error: string): { ok: false; error: string } => ({ ok: false, error })

/** Mois valide, et pas dans le futur par rapport au mois civil courant (Paris). */
export function validatePeriod(year: number, month: number, today: Date): Plan<{ year: number; month: number }> {
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(month) || year < 2000 || year > 2100 || month < 1 || month > 12) return ko(PREPAY_ERRORS.period)
  const cur = today.getUTCFullYear() * 12 + today.getUTCMonth()
  if (year * 12 + (month - 1) > cur) return ko(PREPAY_ERRORS.period)
  return { ok: true, value: { year, month } }
}
/**
 * Mois proposés à l'ouverture : le mois en cours (`today`, jour civil Paris en minuit UTC) et les `count - 1` mois
 * précédents, plus récents d'abord, sans ceux déjà ouverts. Valeur au format attendu par l'action (`AAAA-MM`).
 * Remplace `<input type="month">`, que Safari sur macOS affiche comme un champ texte vide sans format.
 */
export function openableMonths(today: Date, opened: ReadonlyArray<{ year: number; month: number }>, count = 24): { value: string; label: string }[] {
  const taken = new Set(opened.map((p) => p.year * 12 + (p.month - 1)))
  const cur = today.getUTCFullYear() * 12 + today.getUTCMonth()
  const out: { value: string; label: string }[] = []
  for (let i = 0; i < count; i++) {
    const idx = cur - i
    if (taken.has(idx)) continue
    const year = Math.floor(idx / 12), month = (idx % 12) + 1
    if (!validatePeriod(year, month, today).ok) continue
    out.push({ value: `${year}-${String(month).padStart(2, "0")}`, label: periodLabel(year, month) })
  }
  return out
}
/** [premier jour, premier jour du mois suivant[ en minuit UTC (jours civils). */
export function monthBounds(year: number, month: number): { start: Date; end: Date } {
  return { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 1)) }
}
export const periodLabel = (year: number, month: number) => new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)))

const DAY = 86_400_000
/** Jours ouvrés (lundi à vendredi) de [from, to] inclus, limités au mois. */
export function businessDaysInMonth(from: Date, to: Date, year: number, month: number): string[] {
  const { start, end } = monthBounds(year, month)
  const a = Math.max(from.getTime(), start.getTime()), b = Math.min(to.getTime(), end.getTime() - DAY)
  const out: string[] = []
  for (let t = a; t <= b; t += DAY) { const d = new Date(t); const w = d.getUTCDay(); if (w !== 0 && w !== 6) out.push(formatDay(d)) }
  return out
}

export interface EmployeeFact { id: string; firstName: string; lastName: string; active: boolean }
export interface TimeclockFact { employeeId: string; date: Date; checkInAt: Date | null; checkOutAt: Date | null }
export interface AbsenceFact { id: string; employeeId: string; type: AbsenceKind; status: "PENDING" | "APPROVED" | "REJECTED"; startDate: Date; endDate: Date }
export interface VariableFact { employeeId: string; kind: VariableKind; amountCents: bigint }
export type AnomalyCode = "INCOMPLETE_TIMECLOCK" | "INVALID_TIMECLOCK" | "PENDING_ABSENCE" | "WORK_ON_ABSENCE"
export const BLOCKING: readonly AnomalyCode[] = ["INCOMPLETE_TIMECLOCK", "INVALID_TIMECLOCK", "PENDING_ABSENCE"]
export const ANOMALY_LABEL: Record<AnomalyCode, string> = {
  INCOMPLETE_TIMECLOCK: "Pointage incomplet (entrée ou sortie manquante)",
  INVALID_TIMECLOCK: "Pointage incohérent (sortie avant l'entrée ou plus de 16 h)",
  PENDING_ABSENCE: "Absence en attente de décision",
  WORK_ON_ABSENCE: "Pointage un jour d'absence validée",
}
export interface Anomaly { code: AnomalyCode; employeeId: string; day: string; blocking: boolean }
export interface PrepayLine {
  employeeId: string; name: string; workedMinutes: number; workedDays: number
  absenceDays: Record<AbsenceKind, number>; bonusCents: string; expenseCents: string
}
export interface PrepayResult { lines: PrepayLine[]; anomalies: Anomaly[] }

/** Variables et contrôles d'un mois ; déterministe (salariés triés par nom puis identifiant). */
export function computePrepay(year: number, month: number, f: { employees: readonly EmployeeFact[]; timeclocks: readonly TimeclockFact[]; absences: readonly AbsenceFact[]; variables: readonly VariableFact[] }): PrepayResult {
  const { start, end } = monthBounds(year, month)
  const inMonth = (d: Date) => d.getTime() >= start.getTime() && d.getTime() < end.getTime()
  const anomalies: Anomaly[] = []
  const lines = new Map<string, PrepayLine>()
  const absenceDaysByEmp = new Map<string, Set<string>>()
  for (const e of f.employees) lines.set(e.id, { employeeId: e.id, name: `${e.lastName} ${e.firstName}`.trim(), workedMinutes: 0, workedDays: 0, absenceDays: { VACATION: 0, SICK: 0, UNPAID: 0, TRAINING: 0, OTHER: 0 }, bonusCents: "0", expenseCents: "0" })
  // Ordre déterministe ; un jour couvert par deux absences validées n'est compté qu'une fois (la première, par date
  // de début puis identifiant).
  const absences = [...f.absences].sort((x, y) => x.startDate.getTime() - y.startDate.getTime() || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
  for (const a of absences) {
    const l = lines.get(a.employeeId)
    if (!l || a.status === "REJECTED") continue
    const days = businessDaysInMonth(a.startDate, a.endDate, year, month)
    if (days.length === 0) continue
    if (a.status === "PENDING") { anomalies.push({ code: "PENDING_ABSENCE", employeeId: a.employeeId, day: days[0], blocking: true }); continue }
    const set = absenceDaysByEmp.get(a.employeeId) ?? new Set<string>()
    for (const d of days) if (!set.has(d)) { set.add(d); l.absenceDays[a.type] += 1 }
    absenceDaysByEmp.set(a.employeeId, set)
  }
  for (const t of f.timeclocks) {
    const l = lines.get(t.employeeId)
    if (!l || !inMonth(t.date)) continue
    const day = formatDay(t.date)
    if (!t.checkInAt || !t.checkOutAt) { anomalies.push({ code: "INCOMPLETE_TIMECLOCK", employeeId: t.employeeId, day, blocking: true }); continue }
    const minutes = Math.round((t.checkOutAt.getTime() - t.checkInAt.getTime()) / 60_000)
    if (minutes <= 0 || minutes > MAX_WORK_MINUTES_PER_DAY) { anomalies.push({ code: "INVALID_TIMECLOCK", employeeId: t.employeeId, day, blocking: true }); continue }
    l.workedMinutes += minutes
    l.workedDays += 1
    if (absenceDaysByEmp.get(t.employeeId)?.has(day)) anomalies.push({ code: "WORK_ON_ABSENCE", employeeId: t.employeeId, day, blocking: false })
  }
  for (const v of f.variables) {
    const l = lines.get(v.employeeId)
    if (!l) continue
    if (v.kind === "BONUS") l.bonusCents = (BigInt(l.bonusCents) + v.amountCents).toString()
    else l.expenseCents = (BigInt(l.expenseCents) + v.amountCents).toString()
  }
  const sorted = [...lines.values()].sort((a, b) => (a.name === b.name ? (a.employeeId < b.employeeId ? -1 : 1) : a.name.localeCompare(b.name, "fr")))
  anomalies.sort((a, b) => (a.day === b.day ? (a.employeeId === b.employeeId ? (a.code < b.code ? -1 : 1) : a.employeeId < b.employeeId ? -1 : 1) : a.day < b.day ? -1 : 1))
  return { lines: sorted, anomalies }
}
export const blockingCount = (r: PrepayResult) => r.anomalies.filter((a) => a.blocking).length

/** Minutes → « 151,67 » (centièmes d'heure, arrondi au plus proche, sans flottant). */
export function hoursDecimal(minutes: number): string {
  const h = Math.floor((minutes * 100 + 30) / 60)
  return `${Math.floor(h / 100)},${String(h % 100).padStart(2, "0")}`
}
/** Centimes → « 1234,50 » (export : sans séparateur de milliers ni symbole). */
export function eurosPlain(cents: string): string {
  const c = BigInt(cents)
  const neg = c < B0, a = neg ? -c : c
  return `${neg ? "-" : ""}${a / B100},${String(a % B100).padStart(2, "0")}`
}
/** Montant saisi « 1 234,50 » → centimes ; positif, deux décimales au plus. */
export function parseAmount(raw: string): Plan<bigint> {
  const s = raw.replace(/[\s  ]/g, "").replace(",", ".")
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s)
  if (!m) return ko(PREPAY_ERRORS.amount)
  const c = BigInt(m[1]) * B100 + BigInt((m[2] ?? "").padEnd(2, "0") || "0")
  return c <= B0 || c > MAX_VARIABLE_CENTS ? ko(PREPAY_ERRORS.amount) : { ok: true, value: c }
}
export function validateLabel(raw: string): Plan<string> {
  // eslint-disable-next-line no-control-regex
  const l = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim()
  return l.length < 2 || l.length > 120 ? ko(PREPAY_ERRORS.label) : { ok: true, value: l }
}

/** Cellule CSV sûre : neutralise les formules (= + - @ tabulation retour) et met entre guillemets si nécessaire. */
export function csvCell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
  return /[;"\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}
export const CSV_HEADER = ["Salarié", "Identifiant", "Heures travaillées", "Jours travaillés", ...ABSENCE_KINDS.map((k) => `${ABSENCE_LABEL[k]} (j)`), "Primes (€)", "Frais (€)"]
/** Export des variables (séparateur « ; », fin de ligne CRLF, BOM UTF-8 pour les tableurs). */
export function toCsv(lines: readonly PrepayLine[]): string {
  const rows = [CSV_HEADER, ...lines.map((l) => [l.name, l.employeeId, hoursDecimal(l.workedMinutes), String(l.workedDays), ...ABSENCE_KINDS.map((k) => String(l.absenceDays[k])), eurosPlain(l.bonusCents), eurosPlain(l.expenseCents)])]
  return `﻿${rows.map((r) => r.map(csvCell).join(";")).join("\r\n")}\r\n`
}

export interface PeriodSnapshot { year: number; month: number; closedOn: string; lines: PrepayLine[]; warnings: Anomaly[] }
export function readSnapshot(raw: unknown): PeriodSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const s = raw as PeriodSnapshot
  if (!Number.isSafeInteger(s.year) || !Number.isSafeInteger(s.month) || typeof s.closedOn !== "string" || !parseDay(s.closedOn) || !Array.isArray(s.lines) || !Array.isArray(s.warnings)) return null
  return s
}
