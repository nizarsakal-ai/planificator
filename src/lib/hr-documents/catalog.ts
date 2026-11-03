/**
 * PLV2-DOC-RH-002 — catalogue des catégories de documents RH.
 * Les 4 codes historiques restent valides sans drapeau ; les autres n'existent que si
 * HR_DOCUMENT_EXTENDED_CATEGORIES_ENABLED=true. `category` reste une chaîne en base : aucune migration.
 */
export type CategoryFamily = "IDENTITY" | "CONTRACT" | "PAY" | "SOCIAL" | "HEALTH" | "QUALIFICATION" | "OTHER"
export type CategoryDefinition = { code: string; label: string; family: CategoryFamily; expires: boolean; extended: boolean }

const definitions: CategoryDefinition[] = [
  { code: "PAYSLIP", label: "Bulletin de paie", family: "PAY", expires: false, extended: false },
  { code: "CONTRACT", label: "Contrat", family: "CONTRACT", expires: false, extended: false },
  { code: "AMENDMENT", label: "Avenant", family: "CONTRACT", expires: false, extended: false },
  { code: "OTHER", label: "Autre document RH", family: "OTHER", expires: false, extended: false },
  { code: "ID_CARD", label: "Carte nationale d’identité", family: "IDENTITY", expires: true, extended: true },
  { code: "PASSPORT", label: "Passeport", family: "IDENTITY", expires: true, extended: true },
  { code: "RESIDENCE_PERMIT", label: "Titre de séjour", family: "IDENTITY", expires: true, extended: true },
  { code: "DRIVING_LICENSE", label: "Permis de conduire", family: "IDENTITY", expires: true, extended: true },
  { code: "ID_PHOTO", label: "Photo d’identité (issue d’une pièce)", family: "IDENTITY", expires: false, extended: true },
  { code: "SOCIAL_SECURITY", label: "Carte Vitale / attestation de sécurité sociale", family: "SOCIAL", expires: false, extended: true },
  { code: "BANK_DETAILS", label: "RIB", family: "SOCIAL", expires: false, extended: true },
  { code: "PROOF_OF_ADDRESS", label: "Justificatif de domicile", family: "SOCIAL", expires: false, extended: true },
  { code: "HEALTH_INSURANCE", label: "Attestation mutuelle", family: "SOCIAL", expires: true, extended: true },
  { code: "EMPLOYER_CERTIFICATE", label: "Attestation employeur", family: "CONTRACT", expires: false, extended: true },
  { code: "WORK_CERTIFICATE", label: "Certificat de travail", family: "CONTRACT", expires: false, extended: true },
  { code: "FINAL_SETTLEMENT", label: "Solde de tout compte", family: "PAY", expires: false, extended: true },
  { code: "MEDICAL_VISIT", label: "Visite médicale", family: "HEALTH", expires: true, extended: true },
  { code: "QUALIFICATION", label: "Diplôme / habilitation (CACES…)", family: "QUALIFICATION", expires: true, extended: true },
]

export const LEGACY_CATEGORIES = ["PAYSLIP", "CONTRACT", "AMENDMENT", "OTHER"] as const
export const ALL_CATEGORY_CODES = definitions.map((d) => d.code)
export const IDENTITY_CATEGORIES = definitions.filter((d) => d.family === "IDENTITY" && d.code !== "ID_PHOTO").map((d) => d.code)

export function extendedCategoriesEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.HR_DOCUMENT_EXTENDED_CATEGORIES_ENABLED === "true"
}
/** Catégories proposées et acceptées : historiques seules tant que le drapeau est absent. */
export function availableCategories(env: NodeJS.ProcessEnv = process.env): CategoryDefinition[] {
  return extendedCategoriesEnabled(env) ? definitions : definitions.filter((d) => !d.extended)
}
export function isAcceptedCategory(code: string, env: NodeJS.ProcessEnv = process.env) {
  return availableCategories(env).some((d) => d.code === code)
}
export function categoryLabel(code: string) {
  return definitions.find((d) => d.code === code)?.label ?? "Document RH"
}
export function categoryDefinition(code: string) {
  return definitions.find((d) => d.code === code)
}
