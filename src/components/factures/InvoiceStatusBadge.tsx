const META: Record<string, { label: string; className: string }> = {
  DRAFT:     { label: "Brouillon",            className: "bg-slate-100 text-slate-600" },
  SENT:      { label: "Émise",                className: "bg-blue-50 text-blue-700" },
  PARTIAL:   { label: "Partiellement payée",  className: "bg-amber-50 text-amber-700" },
  PAID:      { label: "Payée",                className: "bg-green-50 text-green-700" },
  CANCELLED: { label: "Annulée",              className: "bg-red-50 text-red-500" },
  OVERDUE:   { label: "En retard",            className: "bg-red-100 text-red-700" },
  CREDIT:    { label: "Avoir",                className: "bg-indigo-50 text-indigo-700" },
  DEPOSIT:   { label: "Acompte",              className: "bg-purple-50 text-purple-700" },
}

export function InvoiceStatusBadge({ status, kind, overdue }: { status: string; kind?: string; overdue?: boolean }) {
  const key = overdue ? "OVERDUE" : status
  const m = META[key] ?? { label: status, className: "bg-slate-100 text-slate-600" }
  return (
    <span className="inline-flex flex-wrap gap-1">
      {kind === "CREDIT_NOTE" && <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${META.CREDIT.className}`}>Avoir</span>}
      {kind === "DEPOSIT" && <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${META.DEPOSIT.className}`}>Acompte</span>}
      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${m.className}`}>{kind === "CREDIT_NOTE" && status === "SENT" ? "Émis" : m.label}</span>
    </span>
  )
}
