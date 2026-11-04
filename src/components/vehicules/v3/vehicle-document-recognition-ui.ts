/**
 * Onglet Documents — préremplissage depuis la lecture d'une pièce (logique pure, aucun React, aucun réseau).
 * Une saisie de l'opérateur n'est jamais écrasée ; une valeur reprise d'une version précédente peut l'être par la
 * valeur lue dans le nouveau fichier ; les observations existantes sont complétées, jamais remplacées.
 */
import type { VehicleDocumentCategoryCode } from "@/lib/vehicules/v3/document-view-domain"
import type { ProposedFieldKey, RecognitionConfidence, RecognitionProposal } from "@/lib/vehicules/v3/document-recognition-domain"
import { CATEGORY_FIELDS, VEHICLE_DOCUMENT_CATEGORY_LABELS } from "./vehicle-document-ui"

export type RecognizableKey = ProposedFieldKey | "observations"
export type RecognizableForm = Record<RecognizableKey, string>
export type FilledFields = Partial<Record<RecognizableKey, RecognitionConfidence>>

/** Champs que le formulaire de la rubrique affiche : une proposition hors formulaire est ignorée. */
function shownKeys(category: VehicleDocumentCategoryCode): ProposedFieldKey[] {
  const fields = CATEGORY_FIELDS[category]
  return (["issuedOn", "validFrom", "validUntil", "issuerName", "referenceNumber", "mileage"] as const)
    .filter((key) => key === "issuedOn" || (key === "mileage" ? !!fields.mileage : !!fields[key]))
}

export function applyRecognition<F extends RecognizableForm>(form: F, touched: ReadonlySet<string>, proposal: RecognitionProposal, category: VehicleDocumentCategoryCode): { form: F; filled: FilledFields } {
  const next = { ...form }
  const filled: FilledFields = {}
  if (proposal.category !== category) return { form, filled }
  for (const key of shownKeys(category)) {
    const field = proposal.fields[key]
    if (!field || touched.has(key)) continue
    next[key] = (key === "mileage" ? String(field.value) : field.value) as F[typeof key]
    filled[key] = field.confidence
  }
  if (proposal.observations.length && !touched.has("observations")) {
    const existing = form.observations.trim()
    const added = proposal.observations.filter((line) => !existing.includes(line))
    if (added.length) {
      next.observations = (existing ? `${existing}\n${added.join("\n")}` : added.join("\n")).slice(0, 2000) as F["observations"]
      filled.observations = "TO_CHECK"
    }
  }
  return { form: next, filled }
}

const RECOGNIZABLE_KEYS: readonly RecognizableKey[] = ["issuedOn", "validFrom", "validUntil", "issuerName", "referenceNumber", "mileage", "observations"]

/** Nouveau fichier ou fichier retiré : les champs non saisis à la main reprennent leur valeur d'ouverture du formulaire. */
export function resetUntouched<F extends RecognizableForm>(form: F, touched: ReadonlySet<string>, initial: RecognizableForm): F {
  const next = { ...form }
  for (const key of RECOGNIZABLE_KEYS) if (!touched.has(key)) next[key] = initial[key] as F[typeof key]
  return next
}

export function recognitionFieldLabel(confidence: RecognitionConfidence | undefined): string | null {
  return confidence === "READ" ? "lu dans le document" : confidence === "TO_CHECK" ? "lu, à vérifier" : null
}

/** Synthèse affichée sous le fichier choisi. */
export function recognitionSummary(proposal: RecognitionProposal, filledCount: number): { tone: "info" | "warning"; text: string } {
  const { status, durationMs } = proposal.reading
  const seconds = `${(durationMs / 1000).toFixed(1).replace(".", ",")} s`
  if (status === "ENGINE_MISSING") return { tone: "warning", text: "Lecture automatique indisponible sur ce serveur. Saisissez les informations." }
  if (status === "TECHNICAL_FAILURE") return { tone: "warning", text: "Le document n'a pas pu être lu automatiquement. Saisissez les informations." }
  if (status === "UNREADABLE") return { tone: "warning", text: "Document illisible pour la lecture automatique (photo floue ou trop sombre ?). Saisissez les informations." }
  const source = status === "TEXT_LAYER" ? "texte du PDF" : "lecture de l'image"
  if (!filledCount) return { tone: "warning", text: `Aucune information reconnue (${source}, ${seconds}). Saisissez les informations.` }
  return { tone: "info", text: `${filledCount} information${filledCount > 1 ? "s" : ""} préremplie${filledCount > 1 ? "s" : ""} (${source}, ${seconds}). Vérifiez chaque champ avant de valider : rien n'est validé automatiquement.` }
}

export function recognitionChecks(proposal: RecognitionProposal): { tone: "ok" | "warning"; text: string }[] {
  const out = proposal.checks.map((check) => check.kind === "PLATE"
    ? check.outcome === "MATCH"
      ? { tone: "ok" as const, text: `Immatriculation lue ${check.read} : identique au véhicule.` }
      : { tone: "warning" as const, text: `Immatriculation lue ${check.read} : différente du véhicule (${check.expected ?? "—"}). Vérifiez qu'il s'agit du bon véhicule.` }
    : check.outcome === "MATCH"
      ? { tone: "ok" as const, text: `Marque lue ${check.read} : cohérente avec la fiche.` }
      : { tone: "warning" as const, text: `Marque lue ${check.read} : la fiche indique ${check.expected ?? "aucune marque"}.` })
  if (proposal.otherCategory) out.push({ tone: "warning", text: `Ce document ressemble plutôt à : ${VEHICLE_DOCUMENT_CATEGORY_LABELS[proposal.otherCategory]}. Vérifiez la rubrique.` })
  return out
}

export function recognitionError(code?: string): string {
  switch (code) {
    case "RECOGNITION_BUSY": return "Une autre lecture est en cours. Saisissez les informations ou rechoisissez le fichier dans un instant."
    case "RECOGNITION_TIMEOUT": return "La lecture automatique a pris trop de temps. Saisissez les informations."
    case "DOCUMENT_FILE_TOO_LARGE": case "DOCUMENT_TYPE_NOT_ALLOWED": case "DOCUMENT_TYPE_MISMATCH": case "DOCUMENT_ACTIVE_CONTENT": return "Ce fichier ne peut pas être lu automatiquement ; il sera contrôlé à l'enregistrement."
    default: return "Lecture automatique indisponible. Saisissez les informations."
  }
}

/**
 * Dernière lecture seulement : `start` annule la précédente et rend un jeton ; une réponse n'est appliquée que si son
 * jeton est encore le courant. `cancel` (fichier changé, formulaire fermé ou rouvert) périme toute lecture en vol.
 */
export function createLatestOnly() {
  let current = 0
  let controller: AbortController | null = null
  return {
    start() { controller?.abort(); controller = new AbortController(); current++; return { token: current, signal: controller.signal } },
    cancel() { controller?.abort(); controller = null; current++ },
    isCurrent(token: number) { return token === current },
  }
}
