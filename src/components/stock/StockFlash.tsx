// Lot A : message de retour des actions (paramètres ?ok= / ?erreur=), affiché comme texte, jamais interprété.
export function StockFlash({ params }: { params: Record<string, string | string[] | undefined> }) {
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v.slice(0, 300) : "")
  const ok = one(params.ok)
  const err = one(params.erreur)
  if (!ok && !err) return null
  return err
    ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>
    : <p role="status" className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">{ok}</p>
}

export const SELECT_CLASS = "h-10 rounded-md border border-input bg-background px-3 text-sm"

export const ORDER_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Brouillon", ORDERED: "Passée", PARTIALLY_RECEIVED: "Partiellement reçue", RECEIVED: "Reçue", CANCELLED: "Annulée",
}
export const ORDER_STATUS_CLASS: Record<string, string> = {
  DRAFT: "bg-slate-100 text-slate-700", ORDERED: "bg-blue-50 text-blue-700", PARTIALLY_RECEIVED: "bg-amber-50 text-amber-700",
  RECEIVED: "bg-green-50 text-green-700", CANCELLED: "bg-red-50 text-red-600",
}
export const MOVEMENT_LABEL: Record<string, string> = { RECEIPT: "Entrée", ISSUE: "Sortie", TRANSFER: "Transfert", ADJUSTMENT: "Ajustement" }
export const MATCH_LABEL: Record<string, { label: string; className: string }> = {
  EN_ATTENTE: { label: "Facture en attente", className: "bg-slate-100 text-slate-700" },
  CONFORME: { label: "Conforme", className: "bg-green-50 text-green-700" },
  ECART_FACTURE: { label: "Écart facture / réception", className: "bg-red-50 text-red-600" },
}
