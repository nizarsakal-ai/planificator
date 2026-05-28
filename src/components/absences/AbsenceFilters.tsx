"use client"

import { useState, useMemo } from "react"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { AbsenceActions } from "./AbsenceActions"
import { CalendarOff } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"

const TYPE_LABELS: Record<string, string> = {
  VACATION: "Congé payé",
  SICK:     "Maladie",
  UNPAID:   "Congé sans solde",
  TRAINING: "Formation",
  OTHER:    "Autre",
}

const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  PENDING:  { label: "En attente", cls: "bg-amber-100 text-amber-700 border-amber-200" },
  APPROVED: { label: "Approuvé",   cls: "bg-green-100 text-green-700 border-green-200" },
  REJECTED: { label: "Refusé",     cls: "bg-red-100 text-red-700 border-red-200" },
}

function formatDate(d: Date) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", year: "numeric" }).format(d)
}
function diffDays(start: Date, end: Date) {
  return Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1
}

interface AbsenceRow {
  id: string
  status: string
  type: string
  startDate: Date
  endDate: Date
  reason: string | null
  refusalNote: string | null
  employee: { firstName: string; lastName: string }
}

interface Employee { id: string; firstName: string; lastName: string }

interface Props {
  absences:  AbsenceRow[]
  employees: Employee[]
}

export function AbsenceFilters({ absences, employees }: Props) {
  const [statusFilter,   setStatusFilter]   = useState("ALL")
  const [typeFilter,     setTypeFilter]     = useState("ALL")
  const [employeeFilter, setEmployeeFilter] = useState("ALL")
  const [fromFilter,     setFromFilter]     = useState("")
  const [toFilter,       setToFilter]       = useState("")

  const filtered = useMemo(() => {
    return absences.filter((a) => {
      if (statusFilter   !== "ALL" && a.status       !== statusFilter)   return false
      if (typeFilter     !== "ALL" && a.type         !== typeFilter)     return false
      if (employeeFilter !== "ALL") {
        const fullName = `${a.employee.firstName} ${a.employee.lastName}`
        if (!fullName.toLowerCase().includes(employeeFilter.toLowerCase()) &&
            !a.employee.firstName.toLowerCase().includes(employeeFilter.toLowerCase()) &&
            !a.employee.lastName.toLowerCase().includes(employeeFilter.toLowerCase())) return false
      }
      if (fromFilter) {
        const from = new Date(fromFilter)
        if (a.endDate < from) return false
      }
      if (toFilter) {
        const to = new Date(toFilter)
        if (a.startDate > to) return false
      }
      return true
    })
  }, [absences, statusFilter, typeFilter, employeeFilter, fromFilter, toFilter])

  return (
    <div className="space-y-4">
      {/* Filtres */}
      <div className="flex flex-wrap gap-3 items-center">
        {/* Status */}
        <div className="flex gap-1.5">
          {["ALL", "PENDING", "APPROVED", "REJECTED"].map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                statusFilter === s
                  ? "bg-[#0f3460] text-white border-[#0f3460]"
                  : "text-slate-500 border-slate-200 hover:bg-slate-50"
              }`}
            >
              {s === "ALL" ? "Tous" : STATUS_STYLE[s]?.label ?? s}
            </button>
          ))}
        </div>

        {/* Type */}
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-700 focus:outline-none"
        >
          <option value="ALL">Tous les types</option>
          {Object.entries(TYPE_LABELS).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>

        {/* Employé */}
        <select
          value={employeeFilter}
          onChange={(e) => setEmployeeFilter(e.target.value)}
          className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-700 focus:outline-none"
        >
          <option value="ALL">Tous les employés</option>
          {employees.map((e) => (
            <option key={e.id} value={`${e.firstName} ${e.lastName}`}>
              {e.firstName} {e.lastName}
            </option>
          ))}
        </select>

        {/* Dates */}
        <Input
          type="date"
          value={fromFilter}
          onChange={(e) => setFromFilter(e.target.value)}
          className="h-8 w-36 text-xs"
          placeholder="Début"
        />
        <span className="text-xs text-slate-400">→</span>
        <Input
          type="date"
          value={toFilter}
          onChange={(e) => setToFilter(e.target.value)}
          className="h-8 w-36 text-xs"
        />

        {(statusFilter !== "ALL" || typeFilter !== "ALL" || employeeFilter !== "ALL" || fromFilter || toFilter) && (
          <button
            onClick={() => { setStatusFilter("ALL"); setTypeFilter("ALL"); setEmployeeFilter("ALL"); setFromFilter(""); setToFilter("") }}
            className="text-xs text-slate-400 hover:text-slate-600 underline"
          >
            Réinitialiser
          </button>
        )}
      </div>

      {/* Liste */}
      {filtered.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <CalendarOff className="h-10 w-10 text-slate-200 mx-auto mb-3" />
            <p className="text-slate-400 font-medium">Aucune absence trouvée.</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="divide-y divide-slate-50">
              {filtered.map((absence) => {
                const st   = STATUS_STYLE[absence.status] ?? { label: absence.status, cls: "bg-slate-100 text-slate-600 border-slate-200" }
                const days = diffDays(absence.startDate, absence.endDate)
                return (
                  <div key={absence.id} className="flex items-start justify-between px-5 py-3.5 hover:bg-slate-50 transition-colors">
                    <div className="flex items-start gap-4">
                      {/* Avatar */}
                      <div className="w-9 h-9 rounded-full bg-slate-100 flex items-center justify-center text-xs font-bold text-slate-600 shrink-0 mt-0.5">
                        {absence.employee.firstName[0]}{absence.employee.lastName[0]}
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-slate-800">
                          {absence.employee.firstName} {absence.employee.lastName}
                        </p>
                        <p className="text-xs text-slate-500 mt-0.5">
                          {TYPE_LABELS[absence.type] ?? absence.type} ·{" "}
                          {formatDate(absence.startDate)} → {formatDate(absence.endDate)}{" "}
                          <span className="text-slate-400">({days}j)</span>
                        </p>
                        {absence.reason && (
                          <p className="text-xs text-slate-400 mt-0.5 italic">{absence.reason}</p>
                        )}
                        {absence.refusalNote && (
                          <p className="text-xs text-red-500 mt-0.5">
                            Motif refus : {absence.refusalNote}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0 ml-4">
                      <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full border ${st.cls}`}>
                        {st.label}
                      </span>
                      <AbsenceActions absenceId={absence.id} status={absence.status} />
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-slate-400">{filtered.length} résultat{filtered.length !== 1 ? "s" : ""}</p>
    </div>
  )
}
