"use client"

import { useState } from "react"
import { LayoutList, Map } from "lucide-react"
import dynamic from "next/dynamic"

const PointagesMap = dynamic(
  () => import("./PointagesMap").then((m) => m.PointagesMap),
  { ssr: false, loading: () => <div className="h-[400px] bg-slate-50 rounded-xl animate-pulse" /> }
)

interface PointageEntry {
  id:          string
  date:        Date
  checkInAt:   Date | null
  checkInLat:  number | null
  checkInLng:  number | null
  checkOutAt:  Date | null
  checkOutLat: number | null
  checkOutLng: number | null
  employee:    { firstName: string; lastName: string; avatarUrl: string | null }
  worksite:    { name: string } | null
}

interface Props {
  pointages: PointageEntry[]
}

function fmt(d: Date | null) {
  if (!d) return "—"
  return new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(new Date(d))
}

function duration(a: Date, b: Date) {
  const ms = new Date(b).getTime() - new Date(a).getTime()
  const h  = Math.floor(ms / 3600000)
  const m  = Math.floor((ms % 3600000) / 60000)
  return `${h}h${m.toString().padStart(2, "0")}`
}

function initials(firstName: string, lastName: string) {
  return `${firstName[0] ?? ""}${lastName[0] ?? ""}`.toUpperCase()
}

export function PointagesAdminView({ pointages }: Props) {
  const [view, setView] = useState<"list" | "map">("list")

  return (
    <div className="space-y-4">
      {/* Toggle */}
      <div className="flex justify-end">
        <div className="flex bg-slate-100 rounded-lg p-1 gap-1">
          <button
            onClick={() => setView("list")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              view === "list" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
            }`}
          >
            <LayoutList className="h-4 w-4" /> Liste
          </button>
          <button
            onClick={() => setView("map")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              view === "map" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
            }`}
          >
            <Map className="h-4 w-4" /> Carte
          </button>
        </div>
      </div>

      {view === "map" ? (
        <PointagesMap pointages={pointages} />
      ) : (
        <div className="divide-y divide-slate-50">
          {pointages.map((p) => {
            const hasOut = !!p.checkOutAt
            return (
              <div key={p.id} className="flex items-center gap-3 px-4 py-3">
                {/* Avatar */}
                <div className="w-9 h-9 rounded-full bg-[#0f3460] flex items-center justify-center text-white text-xs font-bold shrink-0">
                  {p.employee.avatarUrl
                    ? <img src={p.employee.avatarUrl} alt="" className="w-full h-full rounded-full object-cover" />
                    : initials(p.employee.firstName, p.employee.lastName)
                  }
                </div>

                {/* Infos */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-slate-800">
                    {p.employee.firstName} {p.employee.lastName}
                  </p>
                  <p className="text-xs text-slate-400">
                    {p.worksite?.name ?? "Sans chantier"}
                    {" · "}
                    {new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short" }).format(new Date(p.date))}
                  </p>
                </div>

                {/* Horaires */}
                <div className="text-right shrink-0">
                  <p className="text-xs font-medium text-slate-700">
                    <span className="text-green-600">{fmt(p.checkInAt)}</span>
                    {" → "}
                    <span className={hasOut ? "text-blue-600" : "text-amber-400"}>{fmt(p.checkOutAt)}</span>
                  </p>
                  {p.checkInAt && p.checkOutAt && (
                    <p className="text-[11px] text-slate-400">{duration(p.checkInAt, p.checkOutAt)}</p>
                  )}
                  {p.checkInAt && !p.checkOutAt && (
                    <p className="text-[11px] text-amber-500">En cours</p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
