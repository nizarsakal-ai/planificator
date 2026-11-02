/**
 * Message de succès de conversion consultation → chantier, avec le sort des pièces jointes.
 * Pur et sans dépendance : testable sans React.
 */

export interface ConversionSuccessMessageInput {
  outcome: "CONVERTED" | "ALREADY_CONVERTED"
  documentCount: number
  skippedAttachmentCount: number
}

function plural(count: number, singular: string, pluralForm: string): string {
  return count > 1 ? pluralForm : singular
}

export function formatConversionSuccessMessage(input: ConversionSuccessMessageInput): string {
  if (input.outcome === "ALREADY_CONVERTED") return "Chantier déjà créé"

  const parts: string[] = ["Chantier créé avec succès"]

  if (input.documentCount > 0) {
    parts.push(
      `${input.documentCount} ${plural(input.documentCount, "pièce jointe copiée", "pièces jointes copiées")}`
    )
  }

  if (input.skippedAttachmentCount > 0) {
    // Pas de promesse : ces pièces jointes sont soit en attente de téléchargement,
    // soit définitivement refusées (type ou taille non autorisés) ou en échec.
    parts.push(
      `${input.skippedAttachmentCount} ${plural(
        input.skippedAttachmentCount,
        "non copiée (téléchargement en attente, en échec ou refusé)",
        "non copiées (téléchargement en attente, en échec ou refusé)"
      )}`
    )
  }

  return parts.join(" — ")
}
