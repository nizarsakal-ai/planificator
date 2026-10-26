const META: Record<string, { label: string; className: string }> = {
  DRAFT:     { label: "Brouillon", className: "bg-slate-100 text-slate-600" },
  SENT:      { label: "Envoyé",    className: "bg-blue-50 text-blue-700" },
  ACCEPTED:  { label: "Accepté",   className: "bg-green-50 text-green-700" },
  REFUSED:   { label: "Refusé",    className: "bg-red-50 text-red-600" },
  EXPIRED:   { label: "Expiré",    className: "bg-amber-50 text-amber-700" },
  CONVERTED: { label: "Converti",  className: "bg-indigo-50 text-indigo-700" },
}

export function QuoteStatusBadge({ status }: { status: string }) {
  const m = META[status] ?? { label: status, className: "bg-slate-100 text-slate-600" }
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${m.className}`}>{m.label}</span>
}
