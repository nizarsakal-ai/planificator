// Liste des factures fournisseurs (/comptabilite/fournisseurs) — action explicite par ligne (29/10/2026, retour Nizar : « aucun bouton
// pour valider, seulement le badge »). Fonction pure : la liste n'exécute JAMAIS de validation directe ; elle ouvre la fiche de
// vérification, où les boutons « Valider et comptabiliser » / « Rejeter » (SupplierValidateButtons) et le formulaire de correction existent.
// Aucune règle comptable n'est modifiée ici.

export type SupplierInvoiceListStatus = "PENDING" | "VALIDATED" | "REJECTED"

export interface SupplierRowAction {
  /** Libellé visible du bouton. */
  label: string
  /** Fiche de la facture (vérification puis validation pour PENDING ; consultation sinon). */
  href: string
  /** Libellé accessible complet (lecteur d'écran, navigation clavier) : action + numéro + fournisseur. */
  ariaLabel: string
  /** Apparence : action principale pour une facture à vérifier, secondaire pour la consultation. */
  variant: "default" | "outline"
}

export function supplierRowAction(row: { id: string; status: SupplierInvoiceListStatus | string; number: string; supplierName: string }): SupplierRowAction {
  const href = `/comptabilite/fournisseurs/${encodeURIComponent(row.id)}`
  const who = `${row.number} — ${row.supplierName}`.trim()
  if (row.status === "PENDING") return { label: "Vérifier / valider", href, ariaLabel: `Vérifier puis valider la facture ${who}`, variant: "default" }
  return { label: "Consulter", href, ariaLabel: `Consulter la facture ${who}`, variant: "outline" }
}
