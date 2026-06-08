"use client"

import { useState } from "react"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { HardHat, MapPin, Calendar, Users, ChevronRight, LayoutGrid, Map, LayoutDashboard, List } from "lucide-react"
import dynamic from "next/dynamic"

const ChantiersMap = dynamic(
  () => import("./ChantiersMap").then((m) => m.ChantiersMap),
  { ssr: false, loading: () => <div className="h-[500px] bg-slate-50 rounded-xl animate-pulse" /> }
)

interface TeamInfo {
  id: string
  name: string
  color: string | null
  leader: { firstName: string; lastName: string; avatarUrl: string | null }
}

interface Chantier {
  id: string
  name: string
  address: string | null
  status: string
  latitude: number | null
  longitude: number | null
  startDate: Date
  endDate: Date
  client: { name: string }
  _count: { assignments: number }
  assignments: { teamId: string; team: TeamInfo }[]
}

function getInitials(firstName: string, lastName: string) {
  return `${firstName[0] ?? ""}${lastName[0] ?? ""}`.toUpperCase()
}

function getUniqueTeams(assignments: { teamId: string; team: TeamInfo }[]): TeamInfo[] {
  const seen = new Set<string>()
  const teams: TeamInfo[] = []
  for (const a of assignments) {
    if (!seen.has(a.teamId)) {
      seen.add(a.teamId)
      teams.push(a.team)
    }
  }
  return teams
}

function TeamAvatars({ teams, size = "md" }: { teams: TeamInfo[]; size?: "sm" | "md" }) {
  const visible = teams.slice(0, 3)
  const extra = teams.length - visible.length
  const dim = size === "sm" ? "w-6 h-6 text-[9px]" : "w-8 h-8 text-xs"

  return (
    <div className="flex items-center -space-x-2">
      {visible.map((team) => (
        <div key={team.id} className="flex items-center -space-x-1">
          {/* Initiales avec couleur */}
          <div
            title={`${team.leader.firstName} ${team.leader.lastName} — ${team.name}`}
            className={`${dim} rounded-full border-2 border-white flex items-center justify-center font-bold text-white shrink-0`}
            style={{ backgroundColor: team.color ?? "#0f3460" }}
          >
            {getInitials(team.leader.firstName, team.leader.lastName)}
          </div>
          {/* Photo si disponible */}
          {team.leader.avatarUrl && (
            <div
              title={`${team.leader.firstName} ${team.leader.lastName}`}
              className={`${dim} rounded-full border-2 border-white shrink-0 overflow-hidden`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={team.leader.avatarUrl} alt={`${team.leader.firstName} ${team.leader.lastName}`} className="w-full h-full object-cover" />
            </div>
          )}
        </div>
      ))}
      {extra > 0 && (
        <div className={`${dim} rounded-full border-2 border-white bg-slate-300 flex items-center justify-center font-bold text-slate-600 shrink-0`}>
          +{extra}
        </div>
      )}
    </div>
  )
}

interface ChantiersViewProps {
  chantiers: Chantier[]
}

const statusLabels: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  PLANNED:     { label: "Planifié",       variant: "secondary" },
  IN_PROGRESS: { label: "En cours",      variant: "default" },
  EXTENDED:    { label: "Prolongé",      variant: "outline" },
  COMPLETED:   { label: "Terminé",       variant: "secondary" },
  ARCHIVED:    { label: "Archivé",       variant: "secondary" },
  DELAYED:     { label: "Décalé",        variant: "destructive" },
}

function formatDate(date: Date) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", year: "numeric" }).format(date)
}

export function ChantiersView({ chantiers }: ChantiersViewProps) {
  const [view, setView] = useState<"grid" | "mosaic" | "list" | "map">("grid")

  return (
    <div className="space-y-4">
      {/* Toggle */}
      <div className="flex justify-end">
        <div className="flex bg-slate-100 rounded-lg p-1 gap-1">
          <button
            onClick={() => setView("grid")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              view === "grid" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
            }`}
          >
            <LayoutGrid className="h-4 w-4" />
            Grille
          </button>
          <button
            onClick={() => setView("mosaic")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              view === "mosaic" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
            }`}
          >
            <LayoutDashboard className="h-4 w-4" />
            Mosaïque
          </button>
          <button
            onClick={() => setView("list")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              view === "list" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
            }`}
          >
            <List className="h-4 w-4" />
            Liste
          </button>
          <button
            onClick={() => setView("map")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              view === "map" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
            }`}
          >
            <Map className="h-4 w-4" />
            Carte
          </button>
        </div>
      </div>

      {view === "map" ? (
        <ChantiersMap chantiers={chantiers} />
      ) : view === "list" ? (
        /* Vue Liste — tableau Chantier / Date / Client / Équipe */
        <Card>
          <CardContent className="p-0">
            {/* En-tête */}
            <div className="grid grid-cols-[2fr_2fr_1.5fr_1.5fr] gap-4 px-4 py-2.5 border-b border-slate-100 bg-slate-50 rounded-t-xl">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Chantier</span>
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Date</span>
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Client</span>
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Équipe</span>
            </div>
            {/* Lignes */}
            <div className="divide-y divide-slate-50">
              {chantiers.map((chantier) => {
                const status = statusLabels[chantier.status] ?? { label: chantier.status, variant: "secondary" as const }
                const teams = getUniqueTeams(chantier.assignments)
                return (
                  <Link key={chantier.id} href={`/chantiers/${chantier.id}`} className="grid grid-cols-[2fr_2fr_1.5fr_1.5fr] gap-4 px-4 py-3 hover:bg-slate-50 transition-colors items-center">
                    {/* Chantier */}
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center shrink-0">
                        <HardHat className="h-3.5 w-3.5 text-slate-500" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-800 truncate">{chantier.name}</p>
                        <Badge variant={status.variant} className="text-[10px] px-1.5 py-0 mt-0.5">{status.label}</Badge>
                      </div>
                    </div>
                    {/* Date */}
                    <div className="flex items-center gap-1.5 text-xs text-slate-500">
                      <Calendar className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                      <span className="truncate">{formatDate(chantier.startDate)} → {formatDate(chantier.endDate)}</span>
                    </div>
                    {/* Client */}
                    <p className="text-sm text-slate-600 truncate">{chantier.client.name}</p>
                    {/* Équipe */}
                    {teams.length > 0 ? (
                      <div className="flex items-center gap-2">
                        <TeamAvatars teams={teams} size="sm" />
                        <span className="text-xs text-slate-500 truncate hidden lg:block">
                          {teams.length === 1 ? teams[0].name : `${teams.length} équipes`}
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs text-slate-300">—</span>
                    )}
                  </Link>
                )
              })}
            </div>
          </CardContent>
        </Card>
      ) : view === "mosaic" ? (
        /* Vue Mosaïque — grille compacte */
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {chantiers.map((chantier) => {
            const status = statusLabels[chantier.status] ?? { label: chantier.status, variant: "secondary" as const }
            const teams = getUniqueTeams(chantier.assignments)
            return (
              <Link key={chantier.id} href={`/chantiers/${chantier.id}`}>
                <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
                  <CardContent className="p-3 flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-1">
                      <div className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center shrink-0">
                        <HardHat className="h-4 w-4 text-slate-500" />
                      </div>
                      <Badge variant={status.variant} className="text-[10px] px-1.5 py-0.5 shrink-0">{status.label}</Badge>
                    </div>
                    <div>
                      <p className="font-semibold text-slate-900 text-xs leading-tight line-clamp-2">{chantier.name}</p>
                      <p className="text-[10px] text-slate-400 mt-0.5 truncate">{chantier.client.name}</p>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1 text-[10px] text-slate-400">
                        <Calendar className="h-3 w-3 shrink-0" />
                        <span className="truncate">{formatDate(chantier.endDate)}</span>
                      </div>
                      {teams.length > 0 && <TeamAvatars teams={teams} size="sm" />}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            )
          })}
        </div>
      ) : (
        /* Vue Grille */
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {chantiers.map((chantier) => {
            const status = statusLabels[chantier.status] ?? { label: chantier.status, variant: "secondary" as const }
            const teams = getUniqueTeams(chantier.assignments)
            return (
              <Link key={chantier.id} href={`/chantiers/${chantier.id}`}>
                <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
                  <CardContent className="p-5 flex flex-col gap-3">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center shrink-0">
                          <HardHat className="h-5 w-5 text-slate-500" />
                        </div>
                        <div>
                          <p className="font-semibold text-slate-900 text-sm leading-tight">{chantier.name}</p>
                          <p className="text-xs text-slate-400 mt-0.5">{chantier.client.name}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <Badge variant={status.variant} className="text-xs shrink-0">{status.label}</Badge>
                        <ChevronRight className="h-4 w-4 text-slate-300" />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      {chantier.address && (
                        <div className="flex items-center gap-2 text-xs text-slate-500">
                          <MapPin className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{chantier.address}</span>
                        </div>
                      )}
                      <div className="flex items-center gap-2 text-xs text-slate-500">
                        <Calendar className="h-3.5 w-3.5 shrink-0" />
                        {formatDate(chantier.startDate)} → {formatDate(chantier.endDate)}
                      </div>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-xs text-slate-500">
                          <Users className="h-3.5 w-3.5 shrink-0" />
                          {chantier._count.assignments} affectation{chantier._count.assignments > 1 ? "s" : ""}
                        </div>
                        {teams.length > 0 && <TeamAvatars teams={teams} />}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
