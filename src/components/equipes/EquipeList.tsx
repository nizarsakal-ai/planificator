"use client"

import Link from "next/link"
import { Card } from "@/components/ui/card"
import type { EquipeViewItem } from "@/lib/equipes/equipes-view"
import { EquipeActionsMenu, type EquipeTruckOption } from "./EquipeActionsMenu"
import { EquipeMark, EquipeStatusPill, fullName, VehicleLabel, WorksiteLabel } from "./EquipeCard"

interface EquipeListProps {
  teams: EquipeViewItem[]
  trucks: EquipeTruckOption[]
  canManage: boolean
}

const TH = "px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500"
const TD = "px-4 py-3 text-sm"

/** Vue Liste : tableau défilant horizontalement sur petit écran (la page, elle, ne défile pas). */
export function EquipeList({ teams, trucks, canManage }: EquipeListProps) {
  return (
    <Card className="overflow-hidden border border-slate-100">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[56rem]">
          <thead className="border-b border-slate-100 bg-slate-50/60">
            <tr>
              <th scope="col" className={TH}>Équipe</th>
              <th scope="col" className={TH}>Statut</th>
              <th scope="col" className={TH}>Membres</th>
              <th scope="col" className={TH}>Chef d&apos;équipe</th>
              <th scope="col" className={TH}>Véhicule</th>
              <th scope="col" className={TH}>Chantier aujourd&apos;hui</th>
              <th scope="col" className={`${TH} text-right`}>Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {teams.map((team) => (
              <tr key={team.id} className={`transition-colors hover:bg-slate-50 ${team.active ? "" : "opacity-70"}`}>
                <td className={TD}>
                  <Link
                    href={`/equipes/${team.id}`}
                    className="flex items-center gap-2.5 rounded font-semibold text-slate-900 hover:text-[#0f3460] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <EquipeMark team={team} className="h-7 w-7 text-xs" />
                    <span className="truncate">{team.name}</span>
                  </Link>
                </td>
                <td className={TD}>
                  <EquipeStatusPill active={team.active} />
                </td>
                <td className={`${TD} tabular-nums text-slate-700`}>{team.members.length}</td>
                <td className={`${TD} text-slate-700`}>{fullName(team.leader)}</td>
                <td className={TD}>
                  <VehicleLabel truck={team.truck} />
                </td>
                <td className={TD}>
                  <WorksiteLabel team={team} />
                </td>
                <td className={`${TD} text-right`}>
                  <div className="inline-flex">
                    <EquipeActionsMenu team={team} trucks={trucks} canManage={canManage} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
