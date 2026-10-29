// Liste des factures fournisseurs (/comptabilite/fournisseurs) — actions explicites par ligne (29/10/2026, retours Nizar : « aucun bouton
// pour valider, seulement le badge », puis « dissocier Vérifier de Valider »). Fonction pure : pour une facture « À valider », un lien
// « Vérifier » ouvre la fiche et `quickValidate` autorise le bouton « Valider » (SupplierQuickValidateButton), qui appelle l'action serveur
// existante ; sinon « Consulter ». Aucune règle comptable n'est modifiée ici.

export type SupplierInvoiceListStatus = "PENDING" | "VALIDATED" | "REJECTED"

export interface SupplierRowAction {
  /** Libellé visible du bouton. */
  label: string
  /** Fiche de la facture (vérification puis validation pour PENDING ; consultation sinon). */
  href: string
  /** Libellé accessible complet (lecteur d'écran, navigation clavier) : action + numéro + fournisseur. */
  ariaLabel: string
  /** Apparence du lien (secondaire : l'action principale d'une facture à valider est le bouton « Valider »). */
  variant: "default" | "outline"
  /** Vrai seulement pour PENDING : affiche le bouton « Valider » (validation directe par l'action serveur existante). */
  quickValidate: boolean
  /** Libellé accessible du bouton « Valider » (null si non affiché). */
  validateAriaLabel: string | null
}

export function supplierRowAction(row: { id: string; status: SupplierInvoiceListStatus | string; number: string; supplierName: string }): SupplierRowAction {
  const href = `/comptabilite/fournisseurs/${encodeURIComponent(row.id)}`
  const who = `${row.number} — ${row.supplierName}`.trim()
  if (row.status === "PENDING") return { label: "Vérifier", href, ariaLabel: `Vérifier la facture ${who}`, variant: "outline", quickValidate: true, validateAriaLabel: `Valider la facture ${who}` }
  return { label: "Consulter", href, ariaLabel: `Consulter la facture ${who}`, variant: "outline", quickValidate: false, validateAriaLabel: null }
}
