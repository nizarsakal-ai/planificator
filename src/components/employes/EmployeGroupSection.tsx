"use client"

import Link from "next/link"
import { ChevronDown } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { getInitials } from "@/lib/utils"
import { EmployeActionsMenu } from "@/components/employes/EmployeActionsMenu"
import type { EmployeeGroup, EmployeeViewItem } from "@/lib/employes/employes-view"
import type { EmployeViewMode } from "./EmployesToolbar"

/** État visible par texte + pastille (jamais par la couleur seule). */
function StatusPill({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
        active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-emerald-500" : "bg-slate-400"}`} aria-hidden="true" />
      {active ? "Actif" : "Archivé"}
    </span>
  )
}

function TeamLabel({ team }: { team: EmployeeViewItem["team"] }) {
  if (!team) return <span className="text-[11px] text-slate-300">Sans équipe</span>
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: team.color ?? "#0f3460" }} aria-hidden="true" />
      <span className="truncate text-[11px] text-slate-500">{team.name}</span>
    </span>
  )
}

function EmployeAvatar({ e, className }: { e: EmployeeViewItem; className: string }) {
  const fullName = `${e.firstName} ${e.lastName}`
  return (
    <Avatar className={className}>
      {e.avatarUrl && <AvatarImage src={e.avatarUrl} alt={fullName} />}
      <AvatarFallback className="bg-[#0f3460] text-white font-semibold text-xs">{getInitials(fullName)}</AvatarFallback>
    </Avatar>
  )
}

function EmployeCard({ e }: { e: EmployeeViewItem }) {
  const fullName = `${e.firstName} ${e.lastName}`
  return (
    <div className={`relative group ${e.active ? "" : "opacity-70"}`}>
      <Link href={`/employes/${e.id}`} className="absolute inset-0 z-0 rounded-xl" aria-label={`Voir ${fullName}`} />
      <Card className="h-full border border-slate-100 transition-all hover:border-[#0f3460]/30 hover:shadow-md">
        <CardContent className="relative flex flex-col items-center gap-1.5 p-2.5 pt-3 text-center">
          <div className="absolute right-1.5 top-1.5 z-10">
            <EmployeActionsMenu employeeId={e.id} fullName={fullName} active={e.active} />
          </div>
          <EmployeAvatar e={e} className="h-10 w-10" />
          <div className="w-full min-w-0 space-y-0.5">
            <p className="truncate text-sm font-semibold leading-tight text-slate-900 transition-colors group-hover:text-[#0f3460]">
              {fullName}
            </p>
            <p className="truncate text-[11px] text-slate-400">{e.jobTitle || "Fonction non renseignée"}</p>
          </div>
          <div className="flex w-full min-w-0 items-center justify-center gap-2">
            <TeamLabel team={e.team} />
            <StatusPill active={e.active} />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function EmployeRow({ e }: { e: EmployeeViewItem }) {
  const fullName = `${e.firstName} ${e.lastName}`
  return (
    <div className={`relative group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-slate-50 ${e.active ? "" : "opacity-70"}`}>
      <Link href={`/employes/${e.id}`} className="absolute inset-0 z-0" aria-label={`Voir ${fullName}`} />
      <EmployeAvatar e={e} className="h-9 w-9 shrink-0" />
      <div className="grid min-w-0 flex-1 grid-cols-1 items-center gap-0.5 sm:grid-cols-4 sm:gap-2">
        <p className="truncate text-sm font-semibold text-slate-900 transition-colors group-hover:text-[#0f3460]">{fullName}</p>
        <p className="truncate text-xs text-slate-400">{e.jobTitle ?? "—"}</p>
        <p className="hidden truncate text-xs text-slate-400 sm:block">{e.phone ?? "—"}</p>
        <div className="hidden min-w-0 sm:block">
          <TeamLabel team={e.team} />
        </div>
      </div>
      <div className="relative z-10 flex shrink-0 items-center gap-2">
        <StatusPill active={e.active} />
        <EmployeActionsMenu employeeId={e.id} fullName={fullName} active={e.active} />
      </div>
    </div>
  )
}

interface EmployeGroupSectionProps {
  group: EmployeeGroup
  view: EmployeViewMode
  collapsed: boolean
  onToggle: () => void
}

export function EmployeGroupSection({ group, view, collapsed, onToggle }: EmployeGroupSectionProps) {
  const contentId = `employes-group-${group.fonction}`
  return (
    <section aria-labelledby={`${contentId}-title`} className="space-y-3">
      <h2 id={`${contentId}-title`} className="text-base">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-controls={contentId}
          className="flex w-full items-center gap-2 rounded-md text-left ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${collapsed ? "-rotate-90" : ""}`}
            aria-hidden="true"
          />
          <span className="font-semibold text-slate-800">{group.label}</span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium tabular-nums text-slate-500">
            {group.items.length}
          </span>
          <span className="ml-2 h-px flex-1 bg-slate-100" aria-hidden="true" />
        </button>
      </h2>

      {!collapsed && (
        <div id={contentId}>
          {view === "grid" ? (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
              {group.items.map((e) => (
                <EmployeCard key={e.id} e={e} />
              ))}
            </div>
          ) : (
            <Card>
              <CardContent className="divide-y divide-slate-50 p-0">
                {group.items.map((e) => (
                  <EmployeRow key={e.id} e={e} />
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </section>
  )
}
