// SPEC-INVOICE-IMPORT-001 — types partagés (serveur et composants client : aucun import serveur ici).

export type ImportSourceSystem = "TIIME" | "OTHER" | "PDF"
export type ImportRowKind = "INVOICE" | "CREDIT_NOTE" | "SUPPLIER"
export type ImportStatus = "ISSUED" | "PARTIALLY_PAID" | "PAID" | "OVERDUE" | "CANCELLED" | "UNKNOWN"
/** Un conflit n'écrase JAMAIS la pièce existante : la seule décision possible est de la conserver (ligne ignorée). */
export type ConflictDecision = "KEEP"

/** Champs de Planificator auxquels une colonne d'export peut être associée. */
export const IMPORT_FIELDS = ["number", "kind", "client", "issueDate", "dueDate", "totalHT", "vat", "totalTTC", "status", "reference", "creditedNumber", "fileName"] as const
export type ImportField = (typeof IMPORT_FIELDS)[number]
export const IMPORT_FIELD_LABEL: Record<ImportField, string> = {
  number: "Numéro de pièce", kind: "Type de pièce (facture / avoir)", client: "Client", issueDate: "Date d'émission", dueDate: "Date d'échéance",
  totalHT: "Montant HT", vat: "Montant TVA", totalTTC: "Montant TTC", status: "Statut", reference: "Référence / identifiant source",
  creditedNumber: "Facture d'origine (avoirs)", fileName: "Nom du fichier PDF",
}

/** Association colonnes → champs : index de colonne (0-based) ou absent ; `headerRows` lignes d'en-tête à ignorer. */
export type ColumnMapping = Partial<Record<ImportField, number>> & { headerRows: number }

/** Ligne d'aperçu, modifiable avant validation. Les montants sont des centimes en chaîne (BigInt non sérialisable en JSON). */
export interface PreviewRow {
  id: string
  origin: { type: "table" | "pdf"; file: string; line?: number }
  kind: ImportRowKind
  number: string
  clientName: string
  clientId: string | null
  /** Création explicite d'un client à partir de `clientName` (jamais implicite). */
  createClient: boolean
  worksiteId: string | null
  issueDate: string | null // AAAA-MM-JJ
  dueDate: string | null
  htCents: string | null
  vatCents: string | null
  ttcCents: string | null
  sourceStatus: string | null
  status: ImportStatus
  sourceReference: string | null
  creditedNumber: string | null
  fileId: string | null
  fileName: string | null
  /** Nom de PDF attendu d'après l'export (colonne « fichier ») — sert à l'association, pas au stockage. */
  expectedFileName: string | null
  decision: ConflictDecision | null
  excluded: boolean
  /** Extraction automatique indisponible ou partielle (PDF sans texte, OCR désactivé…). */
  extractionNote: string | null
}

export type AnomalyCode =
  | "NUMBER_MISSING" | "DATE_MISSING" | "AMOUNTS_MISSING" | "AMOUNTS_INCONSISTENT"
  | "CLIENT_MISSING" | "CLIENT_AMBIGUOUS" | "CLIENT_TO_CONFIRM"
  | "DUPLICATE_IN_BATCH" | "ALREADY_IMPORTED" | "CONFLICT" | "NATIVE_NUMBER_COLLISION"
  | "PDF_MISSING" | "CREDITED_NOT_FOUND" | "SUPPLIER_DOCUMENT" | "EXTRACTION_INCOMPLETE"

export interface Anomaly { code: AnomalyCode; blocking: boolean; message: string }

export interface ClientCandidate { id: string; name: string }

export interface AnalyzedRow {
  row: PreviewRow
  anomalies: Anomaly[]
  /** IMPORT : sera créée ; SKIP : ignorée (identique, exclue, « conserver ») ; ATTACH : identique, ajoute seulement le PDF manquant ; BLOCKED : empêche la validation ; REDIRECT : facture fournisseur. */
  outcome: "IMPORT" | "SKIP" | "ATTACH" | "BLOCKED" | "REDIRECT"
  /** Client retenu : confirmé par l'utilisateur, ou rapprochement exact et unique. */
  resolvedClientId: string | null
  clientCandidates: ClientCandidate[]
  /** Différences avec la pièce déjà importée (conflit). */
  conflict: { existingId: string; differences: { field: string; existing: string; incoming: string }[] } | null
  credited: { type: "IMPORTED" | "NATIVE" | "BATCH"; id: string; number: string } | null
}

export interface BatchSummary { total: number; toImport: number; toAttach: number; skipped: number; blocked: number; supplier: number }
