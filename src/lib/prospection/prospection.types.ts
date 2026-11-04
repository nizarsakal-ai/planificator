/**
 * Veille prospection (V1) — types du domaine, sans dépendance Prisma ni réseau.
 *
 * Un candidat ne contient que des données publiques d'organisations (acheteurs publics, titulaires, festivals).
 * Aucune donnée de particulier : ni nom de correspondant, ni e-mail, ni adresse postale.
 */

export const PROSPECT_SOURCES = ["BOAMP", "FESTIVALS_CULTURE", "DATATOURISME"] as const
export type ProspectSource = (typeof PROSPECT_SOURCES)[number]

/** TENDER : appel d'offres ouvert ; AWARD : attribution (signal de sous-traitance) ; EVENT : événement récurrent. */
export const PROSPECT_KINDS = ["TENDER", "AWARD", "EVENT"] as const
export type ProspectKind = (typeof PROSPECT_KINDS)[number]

export const PROSPECT_BANDS = ["A_TRAITER", "A_VERIFIER", "MASQUE"] as const
export type ProspectBand = (typeof PROSPECT_BANDS)[number]

/** Suivi humain : aucun passage automatique d'un statut à l'autre, aucun envoi. */
export const PROSPECT_STATUSES = ["NOUVEAU", "A_QUALIFIER", "QUALIFIE", "CONTACTE", "GAGNE", "PERDU", "ECARTE"] as const
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number]

export interface ProspectCandidate {
  source: ProspectSource
  sourceId: string
  kind: ProspectKind
  title: string
  /** Acheteur public ou organisateur (organisation). */
  organization: string | null
  departmentCodes: string[]
  /** Commune de déroulement (événements). */
  locality: string | null
  publishedAt: Date | null
  deadlineAt: Date | null
  /** Début d'un événement daté (DATAtourisme). */
  eventStartAt: Date | null
  /** Libellé de période pour les événements récurrents (ex. « Saison (21 juin - 5 septembre) »). */
  eventPeriod: string | null
  url: string | null
  /** Titulaires d'un marché attribué (organisations publiées au BOAMP). */
  winners: string[]
  /** Avis liés (ex. l'appel d'offres initial d'une attribution). */
  linkedSourceIds: string[]
  /** Descripteurs ou catégories de la source (ex. « Tente », « Stand », discipline d'un festival). */
  descriptors: string[]
  /** Nature brute de l'avis BOAMP (APPEL_OFFRE, PRE-INFORMATION, RECTIFICATIF…). */
  noticeNature: string | null
  /** Envergure d'un événement (Internationale, Nationale…). */
  reach: string | null
  /** Année de création d'un événement récurrent. */
  creationYear: number | null
}

export interface ScoreReason {
  code: string
  label: string
  points: number
}

export interface ScoredCandidate extends ProspectCandidate {
  score: number
  band: ProspectBand
  reasons: ScoreReason[]
  fingerprint: string
  /** Même opportunité vue dans une autre source (`SOURCE:id`). */
  alsoSeenIn: string[]
}
