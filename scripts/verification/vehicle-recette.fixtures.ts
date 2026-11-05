/**
 * R4 — jeu de données SYNTHÉTIQUE de la recette d'intégration locale (Next + authentification + PostgreSQL).
 *
 * Description métier seulement : aucun accès base, aucun écrivain, aucun mot de passe stocké (les mots de passe de
 * recette sont tirés au moment d'une exécution autorisée, puis hachés par bcrypt comme en production). Toutes les
 * valeurs portent le marqueur RECETTE et des adresses électroniques en « .invalid » (domaine réservé, non routable).
 * Les fournisseurs externes (stockage Cloudinary, IGN, prix carburants) ne sont PAS simulés dans Next : ils restent
 * absents et la recette vérifie les réponses « indisponible ». Les doubles éventuels sont nommés DOUBLE-RECETTE-*.
 */
export const RECETTE_MARKER = "RECETTE"
export const RECETTE_EMAIL_DOMAIN = "recette.invalid"

export type RecetteRole = "SUPER_ADMIN" | "ADMIN" | "TEAM_LEADER" | "EMPLOYEE" | "CLIENT"
export type RecetteCompany = { key: string; name: string }
export type RecetteUser = { key: string; email: string; role: RecetteRole; company: string; active: boolean }
export type RecetteTruck = { key: string; company: string; plate: string; label: string }
export type RecetteWorksite = { key: string; company: string; name: string; latitude: number | null; longitude: number | null }
/**
 * Séjour planifié (jours de planning de l'équipe sur un chantier), décalages en jours depuis le jour de recette, qui
 * doit être un LUNDI. `weekdaysOnly` : samedis et dimanches non planifiés. `expected` : un élément par séjour attendu,
 * dans l'ordre, avec la raison de blocage et le nombre de coupures (à décider par l'opérateur) que donne la règle R5 ;
 * vérifié par tests/vehicules/v3/recette-preparation.test.ts avec la règle de production `resolveStays`.
 */
export type StayBlockCode = "OUT_OF_RANGE" | "TOO_LONG" | "NO_HISTORY" | "HANDOVER"
export type RecetteStay = {
  key: string; truck: string; worksite: string; startOffsetDays: number; endOffsetDays: number; weekdaysOnly: boolean
  history: "ASSIGNMENT_HISTORY" | "NONE"; handoverDayOffset: number | null
  expected: { blocked: StayBlockCode | null; gaps: number }[]
}
/** Fenêtre lue par la liste carburant autour du jour de recette (jours). */
export const RECETTE_SCAN_DAYS = 60

export const recetteCompanies: RecetteCompany[] = [
  { key: "alpha", name: "RECETTE Alpha Travaux" },
  { key: "beta", name: "RECETTE Beta Chantiers" },
]

const user = (key: string, role: RecetteRole, company: string, active = true): RecetteUser =>
  ({ key, email: `${key}@${RECETTE_EMAIL_DOMAIN}`, role, company, active })
export const recetteUsers: RecetteUser[] = [
  user("admin-alpha", "ADMIN", "alpha"),
  user("chef-alpha", "TEAM_LEADER", "alpha"),
  user("salarie-alpha", "EMPLOYEE", "alpha"),
  user("client-alpha", "CLIENT", "alpha"),
  user("inactif-alpha", "ADMIN", "alpha", false),
  user("admin-beta", "ADMIN", "beta"),
]

export const recetteTrucks: RecetteTruck[] = [
  { key: "camion-alpha", company: "alpha", plate: "RC-001-AA", label: "RECETTE camion A" },
  { key: "camion-beta", company: "beta", plate: "RC-002-BB", label: "RECETTE camion B" },
  // Un camion par séjour long ou hors fenêtre : ses jours ne se mêlent pas aux autres séjours du camion A.
  { key: "camion-trop-long", company: "alpha", plate: "RC-003-AA", label: "RECETTE camion long séjour" },
  { key: "camion-hors-fenetre", company: "alpha", plate: "RC-004-AA", label: "RECETTE camion hors fenêtre" },
]

export const recetteWorksites: RecetteWorksite[] = [
  { key: "chantier-alpha", company: "alpha", name: "RECETTE chantier Lyon", latitude: 45.764, longitude: 4.8357 },
  { key: "chantier-sans-coordonnees", company: "alpha", name: "RECETTE chantier sans coordonnées", latitude: null, longitude: null },
  { key: "chantier-beta", company: "beta", name: "RECETTE chantier Beta", latitude: 43.6047, longitude: 1.4442 },
]

/** Séjours couvrant chaque raison de blocage actuelle (fenêtre lue : ±60 jours ; plafond 62 jours). */
const stay = (s: Omit<RecetteStay, "truck" | "worksite" | "weekdaysOnly" | "history" | "handoverDayOffset"> & Partial<RecetteStay>): RecetteStay =>
  ({ truck: "camion-alpha", worksite: "chantier-alpha", weekdaysOnly: false, history: "ASSIGNMENT_HISTORY", handoverDayOffset: null, ...s })
export const recetteStays: RecetteStay[] = [
  stay({ key: "sejour-simple", startOffsetDays: 1, endOffsetDays: 4, expected: [{ blocked: null, gaps: 0 }] }),
  // Jeudi → jeudi sans week-end planifié, camion gardé par l'équipe : UN séjour avec une coupure (samedi-dimanche) que
  // l'opérateur doit déclarer « resté sur place » ou « rentré » ; aucune décision prise d'office (R5).
  stay({ key: "sejour-week-end-non-planifie", startOffsetDays: 10, endOffsetDays: 17, weekdaysOnly: true, expected: [{ blocked: null, gaps: 1 }] }),
  stay({ key: "sejour-reaffectation", startOffsetDays: 21, endOffsetDays: 25, handoverDayOffset: 23, expected: [{ blocked: "HANDOVER", gaps: 0 }] }),
  stay({ key: "sejour-sans-historique", truck: "camion-beta", worksite: "chantier-beta", startOffsetDays: 5, endOffsetDays: 8, history: "NONE", expected: [{ blocked: "NO_HISTORY", gaps: 0 }] }),
  stay({ key: "sejour-trop-long", truck: "camion-trop-long", startOffsetDays: -30, endOffsetDays: 40, expected: [{ blocked: "TOO_LONG", gaps: 0 }] }),
  stay({ key: "sejour-hors-fenetre", truck: "camion-hors-fenetre", startOffsetDays: 50, endOffsetDays: 75, expected: [{ blocked: "OUT_OF_RANGE", gaps: 0 }] }),
]

/** Pièces à lire : générées à la volée (aucun document réel) par vehicle-ocr-worker-closure.support. */
export const recetteDocuments = [
  { key: "attestation-couche-texte", kind: "pdf" as const, generator: "syntheticTextPdf", expectedStatus: "TEXT_LAYER" },
  { key: "attestation-image", kind: "png" as const, generator: "syntheticInsurancePng", expectedStatus: "OCR" },
]
