/** Veille prospection — libellés et règles d'affichage (purs, testables). */
import type { ProspectBand, ProspectKind, ProspectSource, ProspectStatus } from "@/lib/prospection/prospection.types"
import { PROSPECT_STATUSES } from "@/lib/prospection/prospection.types"

export const OPPORTUNITY_TABS: ReadonlyArray<{ slug: string; kind: ProspectKind; label: string; hint: string }> = [
  { slug: "appels-offres", kind: "TENDER", label: "Appels d'offres", hint: "Marchés publics ouverts : répondre seul, en groupement ou en sous-traitance d'un candidat." },
  { slug: "sous-traitance", kind: "AWARD", label: "Sous-traitance", hint: "Marchés attribués : les titulaires devront faire monter des structures, proposez-leur vos équipes." },
  { slug: "calendrier", kind: "EVENT", label: "Calendrier", hint: "Festivals et manifestations récurrents : contacter l'organisateur 3 à 6 mois avant l'édition." },
]

export function tabForSlug(slug: string | null | undefined) {
  return OPPORTUNITY_TABS.find((tab) => tab.slug === slug) ?? OPPORTUNITY_TABS[0]
}

export const STATUS_LABELS: Readonly<Record<ProspectStatus, string>> = {
  NOUVEAU: "Nouveau",
  A_QUALIFIER: "À qualifier",
  QUALIFIE: "Qualifié",
  CONTACTE: "Contacté",
  GAGNE: "Gagné",
  PERDU: "Perdu",
  ECARTE: "Écarté",
}

export const BAND_LABELS: Readonly<Record<ProspectBand, string>> = {
  A_TRAITER: "À traiter",
  A_VERIFIER: "À vérifier",
  MASQUE: "Masqué",
}

export const BAND_BADGE_CLASS: Readonly<Record<ProspectBand, string>> = {
  A_TRAITER: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  A_VERIFIER: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  MASQUE: "bg-muted text-muted-foreground",
}

/** Mention de la source, exigée par la Licence Ouverte 2.0. */
export const SOURCE_ATTRIBUTION: Readonly<Record<ProspectSource, string>> = {
  BOAMP: "BOAMP (DILA), Licence Ouverte 2.0",
  FESTIVALS_CULTURE: "Liste des festivals en France (ministère de la Culture), Licence Ouverte 2.0",
  DATATOURISME: "DATAtourisme, Licence Ouverte 2.0",
}

export function parseStatus(value: string | null | undefined): ProspectStatus | null {
  return (PROSPECT_STATUSES as readonly string[]).includes(value ?? "") ? (value as ProspectStatus) : null
}

export function parseDepartmentCode(value: string | null | undefined): string | null {
  const code = (value ?? "").trim().toUpperCase()
  return /^(\d{2}|2A|2B|97\d)$/.test(code) ? code : null
}

const DAY_MS = 24 * 60 * 60 * 1000

/** « Dans 12 jours », « Demain », « Aujourd'hui », « Dépassée ». */
export function deadlineLabel(deadline: Date | null, now: Date): string | null {
  if (!deadline) return null
  const days = Math.floor((deadline.getTime() - now.getTime()) / DAY_MS)
  if (days < 0) return "Dépassée"
  if (days === 0) return "Aujourd'hui"
  if (days === 1) return "Demain"
  return `Dans ${days} jours`
}
