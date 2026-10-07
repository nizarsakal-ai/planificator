import { Archive, CheckCircle2, Layers, Truck, UserCheck } from "lucide-react"
import type { VehicleStats } from "@/lib/vehicules/vehicules-view"

const TILES: {
  key: keyof VehicleStats
  label: string
  Icon: typeof Truck
  tile: string
  icon: string
}[] = [
  { key: "total", label: "Total", Icon: Truck, tile: "border-slate-200 bg-slate-50/60", icon: "bg-slate-100 text-slate-600" },
  { key: "active", label: "Actifs", Icon: CheckCircle2, tile: "border-emerald-100 bg-emerald-50/60", icon: "bg-emerald-100 text-emerald-600" },
  { key: "assigned", label: "Affectés", Icon: UserCheck, tile: "border-blue-100 bg-blue-50/60", icon: "bg-blue-100 text-blue-600" },
  { key: "withoutTeam", label: "Sans équipe", Icon: Layers, tile: "border-amber-100 bg-amber-50/60", icon: "bg-amber-100 text-amber-600" },
  { key: "archived", label: "Archivés", Icon: Archive, tile: "border-orange-100 bg-orange-50/60", icon: "bg-orange-100 text-orange-600" },
]

/** Indicateurs synthétiques du parc (calculés sur tous les véhicules du tenant, indépendamment des filtres). */
export function VehiculesStats({ stats }: { stats: VehicleStats }) {
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
