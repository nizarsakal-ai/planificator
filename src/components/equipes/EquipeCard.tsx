"use client"

import Link from "next/link"
import { Crown, HardHat, Truck, Users } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { getInitials } from "@/lib/utils"
import { formatVehicleIdentity } from "@/lib/vehicules/vehicules-view"
import { splitAvatars, teamSizeHint, type EquipeMember, type EquipeViewItem } from "@/lib/equipes/equipes-view"
import { EquipeActionsMenu, type EquipeTruckOption } from "./EquipeActionsMenu"

export const DEFAULT_TEAM_COLOR = "#0f3460"

export const fullName = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`

/** État par texte + pastille (jamais par la couleur seule). */
export function EquipeStatusPill({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
        active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-emerald-500" : "bg-slate-400"}`} aria-hidden="true" />
      {active ? "Active" : "Archivée"}
    </span>
  )
}

export function EquipeMark({ team, className = "h-9 w-9" }: { team: Pick<EquipeViewItem, "name" | "color">; className?: string }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white ${className}`}
      style={{ backgroundColor: team.color ?? DEFAULT_TEAM_COLOR }}
      aria-hidden="true"
    >
      {team.name.charAt(0).toUpperCase()}
    </span>
  )
}

export function MemberAvatars({ members, color }: { members: EquipeMember[]; color: string | null }) {
  const { visible, overflow } = splitAvatars(members)
  if (members.length === 0) return <span className="text-xs italic text-slate-400">Aucun membre</span>
  return (
    <div className="flex items-center -space-x-2">
      {visible.map((m) => (
        <Avatar key={m.id} className="h-7 w-7 border-2 border-white" title={fullName(m)}>
          {m.avatarUrl && <AvatarImage src={m.avatarUrl} alt={fullName(m)} />}
          <AvatarFallback className="text-[10px] font-medium text-white" style={{ backgroundColor: color ?? DEFAULT_TEAM_COLOR }}>
            {getInitials(fullName(m))}
          </AvatarFallback>
        </Avatar>
      ))}
      {overflow > 0 && (
        <span
          className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-slate-100 text-[10px] font-semibold text-slate-600"
          aria-label={`et ${overflow} autre${overflow > 1 ? "s" : ""}`}
        >
          +{overflow}
        </span>
      )}
    </div>
  )
}

export function VehicleLabel({ truck }: { truck: EquipeViewItem["truck"] }) {
  if (!truck) return <span className="text-slate-400">Sans véhicule</span>
  return (
    <span className="truncate text-slate-700">
      {truck.matricule}
      {formatVehicleIdentity(truck.marque, truck.modele) && (
        <span className="text-slate-400"> · {formatVehicleIdentity(truck.marque, truck.modele)}</span>
      )}
    </span>
  )
}

export function WorksiteLabel({ team }: { team: EquipeViewItem }) {
  if (!team.active || !team.currentWorksite) return <span className="text-slate-400">Aucun chantier aujourd&apos;hui</span>
  return <span className="truncate font-medium text-slate-700">{team.currentWorksite.name}</span>
}

const HINT_TONE = { under: "bg-slate-300", ok: "bg-emerald-500", over: "bg-orange-400" } as const

interface EquipeCardProps {
  team: EquipeViewItem
  trucks: EquipeTruckOption[]
  canManage: boolean
}

export function EquipeCard({ team, trucks, canManage }: EquipeCardProps) {
  const hint = teamSizeHint(team.members.length)
  return (
    <div className={`group relative ${team.active ? "" : "opacity-70"}`}>
      <Link href={`/equipes/${team.id}`} className="absolute inset-0 z-0 rounded-xl" aria-label={`Voir ${team.name}`} />
      <Card className="h-full overflow-hidden border border-slate-100 transition-all group-hover:border-[#0f3460]/30 group-hover:shadow-md">
        <div className="h-1 w-full" style={{ backgroundColor: team.color ?? DEFAULT_TEAM_COLOR }} aria-hidden="true" />
        <CardContent className="space-y-3 p-4">
          <div className="flex items-start gap-3">
            <EquipeMark team={team} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold leading-tight text-slate-900 transition-colors group-hover:text-[#0f3460]">
                {team.name}
              </p>
              <div className="mt-1 flex items-center gap-2">
                <EquipeStatusPill active={team.active} />
                <span className="flex items-center gap-1 text-[11px] text-slate-500">
                  <Users className="h-3 w-3" aria-hidden="true" />
                  {team.members.length} membre{team.members.length > 1 ? "s" : ""}
                </span>
              </div>
            </div>
            <div className="relative z-10 -mr-1 -mt-1">
              <EquipeActionsMenu team={team} trucks={trucks} canManage={canManage} />
            </div>
          </div>

          <dl className="space-y-1.5 text-xs">
            <div className="flex items-center gap-2">
              <dt className="flex items-center" title="Chef d'équipe">
                <Crown className="h-3.5 w-3.5 text-amber-500" aria-hidden="true" />
                <span className="sr-only">Chef d&apos;équipe</span>
              </dt>
              <dd className="truncate text-slate-700">{fullName(team.leader)}</dd>
            </div>
            <div className="flex items-center gap-2">
              <dt className="flex items-center" title="Véhicule">
                <Truck className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                <span className="sr-only">Véhicule</span>
              </dt>
              <dd className="min-w-0 truncate">
                <VehicleLabel truck={team.truck} />
              </dd>
            </div>
            <div className="flex items-center gap-2">
              <dt className="flex items-center" title="Chantier aujourd'hui">
                <HardHat className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                <span className="sr-only">Chantier aujourd&apos;hui</span>
              </dt>
              <dd className="min-w-0 truncate">
                <WorksiteLabel team={team} />
              </dd>
            </div>
          </dl>

          <div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-3">
            <MemberAvatars members={team.members} color={team.color} />
            <div className="w-32 shrink-0 text-right">
              <p className="text-[11px] text-slate-500">{hint.label}</p>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
                <div className={`h-full rounded-full ${HINT_TONE[hint.tone]}`} style={{ width: `${hint.ratio * 100}%` }} />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
