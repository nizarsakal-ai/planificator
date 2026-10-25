/**
 * Onglet Documents — logique d'affichage pure (aucun React, aucun accès réseau).
 * Libellés français, messages d'erreur sans jargon technique, regroupement par rubrique.
 */
import {
  VEHICLE_DOCUMENT_CATEGORIES, VEHICLE_DOCUMENT_CATEGORY_LABELS, VEHICLE_DOCUMENT_STATUS_LABELS,
  type VehicleDocumentCategoryCode, type VehicleDocumentStatus,
} from "@/lib/vehicules/v3/document-view-domain"

export { VEHICLE_DOCUMENT_CATEGORIES, VEHICLE_DOCUMENT_CATEGORY_LABELS, VEHICLE_DOCUMENT_STATUS_LABELS }

export interface DocumentVersionView {
  id: string
  versionNumber: number
  status: string
  originalFilename: string
  mimeType: string
  sizeBytes: number
  issuedOn: string | null
  validFrom: string | null
  validUntil: string | null
  issuerName: string | null
  referenceNumber: string | null
  observations: string | null
  mileage: number | null
  maintenanceEntryId: string | null
  uploadedAt: string
  uploadedByName: string
  verifiedAt: string | null
  verifiedByName: string | null
  supersededAt: string | null
}

export interface DocumentView {
  id: string
  category: VehicleDocumentCategoryCode
  categoryLabel: string
  title: string
  revision: number
  status: VehicleDocumentStatus
  remainingDays: number | null
  validUntil: string | null
  archivedAt: string | null
  archiveReason: string | null
  createdAt: string
  createdByName: string
  currentVersion: DocumentVersionView | null
}

export interface DocumentsSnapshot {
  truckId: string
  matricule: string
  truckActive: boolean
  today: string
  timezone: string
  thresholdsDays: number[]
  visibleCategories: { code: VehicleDocumentCategoryCode; label: string }[]
  documents: DocumentView[]
}

export const CATEGORY_HINTS: Record<VehicleDocumentCategoryCode, string> = {
  TECHNICAL_INSPECTION: "Rapport, date du contrôle et échéance saisie. Aucune périodicité n'est présumée.",
  REPAIR_MAINTENANCE: "Factures et comptes rendus. Le kilométrage est facultatif : une facture ancienne reste conservable sans intervention.",
  REGISTRATION: "Copie privée de la carte grise et version courante. Pas d'échéance.",
  INSURANCE: "Attestation, assureur, numéro de contrat, début et fin de validité.",
  EXPENSE_RECEIPT: "Tickets de carburant et autres factures à relier au registre des dépenses.",
}

export function documentStatusLabel(status: VehicleDocumentStatus | string): string {
  return (VEHICLE_DOCUMENT_STATUS_LABELS as Record<string, string>)[status] ?? "Statut inconnu"
}

export function documentStatusTone(status: VehicleDocumentStatus | string): string {
  switch (status) {
    case "VALID": return "bg-emerald-50 text-emerald-700"
    case "EXPIRING": case "TO_VERIFY": return "bg-amber-50 text-amber-800"
    case "NOT_YET_VALID": return "bg-sky-50 text-sky-800"
    case "EXPIRED": return "bg-red-50 text-red-700"
    case "MISSING": return "bg-slate-100 text-slate-600"
    default: return "bg-slate-100 text-slate-500"
  }
}

/** Regroupe par rubrique visible, dossiers actifs puis archivés ; une rubrique vide reste listée (« Manquant »). */
export function groupDocumentsByCategory(snapshot: Pick<DocumentsSnapshot, "visibleCategories" | "documents">) {
  return snapshot.visibleCategories.map((category) => {
    const documents = snapshot.documents.filter((document) => document.category === category.code)
    return {
      ...category,
      active: documents.filter((document) => !document.archivedAt),
      archived: documents.filter((document) => !!document.archivedAt),
      missing: documents.every((document) => !!document.archivedAt),
    }
  })
}

/** Synthèse pour l'en-tête de la fiche : nombre de pièces à traiter. */
export function documentAlerts(documents: readonly DocumentView[]) {
  const live = documents.filter((document) => !document.archivedAt)
  return {
    expired: live.filter((document) => document.status === "EXPIRED").length,
    expiring: live.filter((document) => document.status === "EXPIRING").length,
    toVerify: live.filter((document) => document.status === "TO_VERIFY").length,
  }
}

export function formatDateFr(dateOnly: string | null | undefined): string {
  if (!dateOnly) return "—"
  const [year, month, day] = dateOnly.split("-")
  return `${day}/${month}/${year}`
}

export function formatInstantFr(iso: string | null | undefined): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} o`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} Ko`
  return `${(size / (1024 * 1024)).toFixed(1).replace(".", ",")} Mo`
}

export function remainingLabel(document: Pick<DocumentView, "remainingDays" | "validUntil" | "status">): string | null {
  if (document.remainingDays === null || !document.validUntil) return null
  if (document.remainingDays < 0) return `Échéance dépassée depuis ${-document.remainingDays} jour${document.remainingDays < -1 ? "s" : ""}`
  if (document.remainingDays === 0) return "Échéance aujourd'hui"
  return `Échéance dans ${document.remainingDays} jour${document.remainingDays > 1 ? "s" : ""}`
}

export function documentUiError(code?: string): string {
  const errors: Record<string, string> = {
    FEATURE_DISABLED: "Le coffre documentaire n'est pas encore activé pour cette application.",
    FORBIDDEN: "Votre rôle ne permet pas cette action sur les documents.",
    UNAUTHENTICATED: "Votre session a expiré. Reconnectez-vous.",
    NO_COMPANY: "Sélectionnez une entreprise pour accéder aux documents.",
    TRUCK_NOT_FOUND: "Ce véhicule n'est plus accessible dans votre entreprise.",
    TRUCK_ARCHIVED: "Le véhicule est archivé : ses documents restent consultables, mais aucun ajout n'est possible.",
    INVALID_ORIGIN: "La demande n'a pas été acceptée. Rechargez la page puis réessayez.",
    INVALID_PAYLOAD: "Vérifiez les champs : rubrique, intitulé et dates au format attendu.",
    INVALID_IDEMPOTENCY_KEY: "La demande est incomplète. Rechargez la page puis réessayez.",
    IDEMPOTENCY_CONFLICT: "Cette demande a déjà été utilisée pour un autre fichier. Actualisez avant de recommencer.",
    DOCUMENT_FILE_EMPTY: "Le fichier est vide.",
    DOCUMENT_FILE_TOO_LARGE: "Le fichier dépasse la taille autorisée (4 Mio).",
    DOCUMENT_TYPE_NOT_ALLOWED: "Seuls les fichiers PDF, JPEG et PNG sont acceptés.",
    DOCUMENT_TYPE_MISMATCH: "Le contenu du fichier ne correspond pas à son extension.",
    DOCUMENT_ACTIVE_CONTENT: "Ce PDF contient des éléments actifs et ne peut pas être conservé. Exportez une version simple.",
    DOCUMENT_FILENAME_INVALID: "Le nom du fichier n'est pas utilisable.",
    DOCUMENT_DATES_INVALID: "La date de début doit précéder la date de fin.",
    DOCUMENT_EXPIRY_NOT_APPLICABLE: "La carte grise n'a pas de date d'échéance.",
    DOCUMENT_MAINTENANCE_LINK_INVALID: "Seule une pièce de réparation ou d'entretien peut être liée à une intervention.",
    DOCUMENT_MAINTENANCE_ENTRY_NOT_FOUND: "L'intervention choisie n'existe pas pour ce véhicule.",
    DOCUMENT_NOT_FOUND: "Ce document n'est pas accessible.",
    DOCUMENT_VERSION_NOT_FOUND: "Cette version n'existe pas.",
    DOCUMENT_VERSION_NOT_CURRENT: "Seule la version courante peut être validée. Actualisez la liste.",
    DOCUMENT_ALREADY_VERIFIED: "Cette version est déjà validée.",
    DOCUMENT_ARCHIVED: "Ce dossier est archivé : il reste consultable mais ne peut plus être modifié.",
    DOCUMENT_REVISION_CONFLICT: "Ce dossier a été modifié entre-temps. Actualisez puis vérifiez votre action.",
    DOCUMENT_STORAGE_FAILED: "Le fichier n'a pas pu être enregistré. Réessayez dans un instant.",
    DOCUMENT_SIGN_FAILED: "Le fichier est momentanément indisponible.",
    DOCUMENT_FETCH_FAILED: "Le fichier est momentanément indisponible.",
    REMINDER_SETTINGS_CONFLICT: "Les seuils ont été modifiés entre-temps. Actualisez puis vérifiez votre saisie.",
  }
  return errors[code ?? ""] ?? "Impossible de terminer l'opération. Actualisez puis réessayez."
}

export const CATEGORY_FIELDS: Record<VehicleDocumentCategoryCode, { issuedOn: string; validFrom?: string; validUntil?: string; issuerName?: string; referenceNumber?: string; mileage?: boolean; maintenance?: boolean }> = {
  TECHNICAL_INSPECTION: { issuedOn: "Date du contrôle", validUntil: "Échéance du contrôle", issuerName: "Centre de contrôle", referenceNumber: "Numéro du procès-verbal" },
  REPAIR_MAINTENANCE: { issuedOn: "Date de la facture ou du compte rendu", issuerName: "Garage ou fournisseur", referenceNumber: "Numéro de facture", mileage: true, maintenance: true },
  REGISTRATION: { issuedOn: "Date d'établissement", issuerName: "Titulaire indiqué", referenceNumber: "Numéro de formule" },
  INSURANCE: { issuedOn: "Date de l'attestation", validFrom: "Début de validité", validUntil: "Fin de validité", issuerName: "Assureur", referenceNumber: "Numéro de contrat" },
  EXPENSE_RECEIPT: { issuedOn: "Date du ticket ou de la facture", issuerName: "Fournisseur", referenceNumber: "Référence", mileage: true },
}
