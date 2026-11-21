// 21/11/2026 — libellés et couleurs des statuts des documents commerciaux.
export type StatusMap = Readonly<Record<string, { label: string; className: string }>>
export const CLIENT_ORDER_STATUS: StatusMap = {
  ISSUED: { label: "Émis", className: "bg-blue-100 text-blue-800" },
  CANCELLED: { label: "Annulé", className: "bg-slate-200 text-slate-600" },
}
export const DELIVERY_STATUS: StatusMap = {
  ISSUED: { label: "À livrer", className: "bg-amber-100 text-amber-800" },
  DELIVERED: { label: "Livré", className: "bg-emerald-100 text-emerald-800" },
  CANCELLED: { label: "Annulé", className: "bg-slate-200 text-slate-600" },
}
export const DELIVERY_SOURCE_LABEL: Readonly<Record<string, string>> = { QUOTE: "Devis", INVOICE: "Facture", CLIENT_ORDER: "Bon de commande" }

export function StatusPill({ map, status }: { map: StatusMap; status: string }) {
  const s = map[status]
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s?.className ?? "bg-slate-100 text-slate-700"}`}>{s?.label ?? status}</span>
}
