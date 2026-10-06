import { Layers, Truck, UserCheck, UserX } from "lucide-react"
import type { EquipeStats as EquipeStatsData } from "@/lib/equipes/equipes-view"

/** Pastels sobres (même langage que la page Employés) : fond léger + bordure assortie ; l'icône porte la couleur. */
const TILES: {
  key: Exclude<keyof EquipeStatsData, "totalTeams">
  label: string
  Icon: typeof Layers
  tile: string
  icon: string
}[] = [
  { key: "activeTeams", label: "Équipes actives", Icon: Layers, tile: "border-blue-100 bg-blue-50/60", icon: "bg-blue-100 text-blue-600" },
  { key: "assignedMembers", label: "Membres affectés", Icon: UserCheck, tile: "border-emerald-100 bg-emerald-50/60", icon: "bg-emerald-100 text-emerald-600" },
  { key: "employeesWithoutTeam", label: "Employés sans équipe", Icon: UserX, tile: "border-orange-100 bg-orange-50/60", icon: "bg-orange-100 text-orange-600" },
  { key: "teamsWithVehicle", label: "Équipes avec véhicule", Icon: Truck, tile: "border-violet-100 bg-violet-50/60", icon: "bg-violet-100 text-violet-600" },
]

/** Indicateurs synthétiques — portent sur les équipes actives et les employés actifs. */
export function EquipeStats({ stats }: { stats: EquipeStatsData }) {
  return (
    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4 min-[1168px]:grid-cols-2 2xl:grid-cols-4">
      {TILES.map(({ key, label, Icon, tile, icon }) => (
        <div key={key} className={`flex items-center gap-3 rounded-xl border px-3.5 py-2.5 ${tile}`}>
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
