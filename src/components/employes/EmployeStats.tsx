import { Archive, HardHat, ShieldCheck, UserCheck, Wrench } from "lucide-react"
import type { EmployeeStats } from "@/lib/employes/employes-view"

const TILES: {
  key: keyof EmployeeStats
  label: string
  Icon: typeof UserCheck
  tone: string
}[] = [
  { key: "active", label: "Employés actifs", Icon: UserCheck, tone: "bg-[#0f3460]/10 text-[#0f3460]" },
  { key: "archived", label: "Employés archivés", Icon: Archive, tone: "bg-slate-100 text-slate-500" },
  { key: "chefs", label: "Chefs d'équipe", Icon: ShieldCheck, tone: "bg-indigo-50 text-indigo-600" },
  { key: "techniciens", label: "Techniciens / Monteurs", Icon: Wrench, tone: "bg-cyan-50 text-cyan-700" },
  { key: "conducteurs", label: "Conducteurs de travaux", Icon: HardHat, tone: "bg-amber-50 text-amber-700" },
]

/** Indicateurs synthétiques — les compteurs par fonction ne portent que sur les employés actifs. */
export function EmployeStats({ stats }: { stats: EmployeeStats }) {
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {TILES.map(({ key, label, Icon, tone }) => (
        <div
          key={key}
          className="flex items-center gap-3 rounded-xl border border-slate-100 bg-white px-4 py-3 shadow-sm last:col-span-2 sm:last:col-span-1"
        >
          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tone}`} aria-hidden="true">
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
