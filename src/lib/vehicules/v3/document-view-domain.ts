/** Constantes et types documentaires partageables côté navigateur. Aucun module serveur. */
export const VEHICLE_DOCUMENT_CATEGORIES = ["TECHNICAL_INSPECTION", "REPAIR_MAINTENANCE", "REGISTRATION", "INSURANCE", "EXPENSE_RECEIPT"] as const
export type VehicleDocumentCategoryCode = (typeof VEHICLE_DOCUMENT_CATEGORIES)[number]

export const VEHICLE_DOCUMENT_CATEGORY_LABELS: Record<VehicleDocumentCategoryCode, string> = {
  TECHNICAL_INSPECTION: "Contrôle technique",
  REPAIR_MAINTENANCE: "Réparations et entretien",
  REGISTRATION: "Carte grise",
  INSURANCE: "Assurance",
  EXPENSE_RECEIPT: "Justificatifs de dépenses",
}

/** Statut documentaire, distinct de l'état technique du camion. */
export type VehicleDocumentStatus =
  | "MISSING"      // aucune version courante
  | "TO_VERIFY"    // version présente, non validée par un humain
  | "NOT_YET_VALID" // début de validité futur
  | "VALID"        // validée, sans échéance ou échéance lointaine
  | "EXPIRING"     // validée, échéance dans le seuil d'alerte
  | "EXPIRED"      // validée ou non, échéance dépassée
  | "HISTORICAL"   // version remplacée
  | "ARCHIVED"     // dossier archivé

export const VEHICLE_DOCUMENT_STATUS_LABELS: Record<VehicleDocumentStatus, string> = {
  MISSING: "Manquant", NOT_YET_VALID: "À venir", TO_VERIFY: "À vérifier", VALID: "Valable", EXPIRING: "Bientôt échu",
  EXPIRED: "Expiré", HISTORICAL: "Historique", ARCHIVED: "Archivé",
}

