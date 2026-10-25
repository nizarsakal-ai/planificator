import Link from "next/link"

export function VehicleWorkspaceNav({ truckId, active, canManage = true }: {
  truckId: string
  active: "documents" | "couts" | "tournees" | "imports"
  canManage?: boolean
}) {
  const root = `/vehicules/${encodeURIComponent(truckId)}`
  const items = [
    { id: "documents", href: root, label: "Documents" },
    { id: "tournees", href: `${root}/tournees`, label: "Tournées" },
    ...(canManage ? [
      { id: "couts", href: `${root}/couts`, label: "Carburant et coûts" },
      { id: "imports", href: `${root}/imports`, label: "Importer des adresses" },
    ] : []),
  ]
  return <nav aria-label="Rubriques du camion" className="flex flex-wrap gap-2 border-b border-slate-200 pb-2">
    {items.map(item => <Link key={item.id} href={item.href} prefetch={false} aria-current={active === item.id ? "page" : undefined}
      className={`rounded-lg px-3 py-2 text-sm font-medium ${active === item.id ? "bg-[#0f3460] text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"}`}>
      {item.label}
    </Link>)}
  </nav>
}
