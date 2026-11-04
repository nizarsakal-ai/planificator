/**
 * Veille prospection — bloc « Opportunités prospection » du tableau de bord SUPER_ADMIN (libellés purs, testables).
 * La collecte est quotidienne : les libellés parlent de la dernière collecte, jamais de temps réel.
 */
import type { ProspectKind } from "@/lib/prospection/prospection.types"

const DAY_MS = 24 * 60 * 60 * 1000
const PARIS = "Europe/Paris"

/** Fenêtre des pistes « nouvelles » : apparues lors des dernières 24 heures. */
export const NEW_OPPORTUNITY_WINDOW_MS = DAY_MS

/** Nombre de pistes affichées sur le tableau de bord. */
export const DASHBOARD_TOP_LIMIT = 4

/** En dessous de ce délai (jours), l'échéance d'un appel d'offres est signalée. */
export const SOON_DEADLINE_DAYS = 10

export const KIND_SHORT_LABELS: Readonly<Record<ProspectKind, string>> = {
  TENDER: "Appel d'offres",
  AWARD: "Sous-traitance",
  EVENT: "Calendrier",
}

/** Onglet de la page `/opportunites` correspondant à un type de piste. */
export const KIND_TAB_SLUGS: Readonly<Record<ProspectKind, string>> = {
  TENDER: "appels-offres",
  AWARD: "sous-traitance",
  EVENT: "calendrier",
}

function parisDay(date: Date): string {
  return new Intl.DateTimeFormat("fr-CA", { timeZone: PARIS, year: "numeric", month: "2-digit", day: "2-digit" }).format(date)
}

function parisTime(date: Date): string {
  const parts = new Intl.DateTimeFormat("fr-FR", { timeZone: PARIS, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date)
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0")
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00"
  return `${hour} h ${minute}`
}

/** « collecte aujourd'hui à 7 h 02 », « collecte hier à 7 h 02 », « collecte du 2 nov. à 7 h 02 », ou aucune collecte. */
export function collectedAtLabel(lastCollectedAt: Date | null, now: Date): string {
  if (!lastCollectedAt) return "aucune collecte pour l'instant"
  const day = parisDay(lastCollectedAt)
  if (day === parisDay(now)) return `collecte aujourd'hui à ${parisTime(lastCollectedAt)}`
  if (day === parisDay(new Date(now.getTime() - DAY_MS))) return `collecte hier à ${parisTime(lastCollectedAt)}`
  const date = new Intl.DateTimeFormat("fr-FR", { timeZone: PARIS, day: "numeric", month: "short" }).format(lastCollectedAt)
  return `collecte du ${date} à ${parisTime(lastCollectedAt)}`
}

/** « Attribué aujourd'hui », « Attribué hier », « Attribué il y a 6 jours ». */
export function awardedAgoLabel(publishedAt: Date | null, now: Date): string | null {
  if (!publishedAt) return null
  const days = Math.max(0, Math.floor((now.getTime() - publishedAt.getTime()) / DAY_MS))
  if (days === 0) return "Attribué aujourd'hui"
  if (days === 1) return "Attribué hier"
  return `Attribué il y a ${days} jours`
}

export function isSoonDeadline(deadlineAt: Date | null, now: Date): boolean {
  if (!deadlineAt) return false
  const days = (deadlineAt.getTime() - now.getTime()) / DAY_MS
  return days >= 0 && days < SOON_DEADLINE_DAYS
}

export function isNewOpportunity(firstSeenAt: Date, now: Date): boolean {
  return now.getTime() - firstSeenAt.getTime() <= NEW_OPPORTUNITY_WINDOW_MS
}
