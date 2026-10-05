import { Archive, HardHat, ShieldCheck, UserCheck, Wrench } from "lucide-react"
import type { EmployeeStats } from "@/lib/employes/employes-view"

/** Pastels sobres : fond très léger + bordure assortie ; l'icône porte la couleur. */
const TILES: {
  key: keyof EmployeeStats
  label: string
  Icon: typeof UserCheck
  tile: string
  icon: string
}[] = [
  { key: "active", label: "Employés actifs", Icon: UserCheck, tile: "border-blue-100 bg-blue-50/60", icon: "bg-blue-100 text-blue-600" },
  { key: "archived", label: "Employés archivés", Icon: Archive, tile: "border-orange-100 bg-orange-50/60", icon: "bg-orange-100 text-orange-600" },
  { key: "chefs", label: "Chefs d'équipe", Icon: ShieldCheck, tile: "border-violet-100 bg-violet-50/60", icon: "bg-violet-100 text-violet-600" },
  { key: "techniciens", label: "Techniciens / Monteurs", Icon: Wrench, tile: "border-emerald-100 bg-emerald-50/60", icon: "bg-emerald-100 text-emerald-600" },
  { key: "conducteurs", label: "Conducteurs de travaux", Icon: HardHat, tile: "border-amber-100 bg-amber-50/60", icon: "bg-amber-100 text-amber-600" },
]

/** Indicateurs synthétiques — les compteurs par fonction ne portent que sur les employés actifs. */
export function EmployeStats({ stats }: { stats: EmployeeStats }) {
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {TILES.map(({ key, label, Icon, tile, icon }) => (
        <div
          key={key}
          className={`flex items-center gap-3 rounded-xl border px-3.5 py-2.5 last:col-span-2 sm:last:col-span-1 ${tile}`}
        >
          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${icon}`} aria-hidden="true">
            <Icon className="h-4 w-4" />
          </span>
          <div className="flex min-w-0 flex-col-reverse">
            <dt className="truncate text-xs text-slate-500">{label}</dt>
            <dd className="text-xl font-bold tabular-nums leading-tight text-slate-900">{stats[key]}</dd>
          </div>
        </div>
      ))}
    </dl>
  )
}
