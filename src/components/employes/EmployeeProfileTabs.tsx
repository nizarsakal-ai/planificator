"use client"

import { useState } from "react"
import { Briefcase, Calendar, ClipboardList } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { EmployeEditForm } from "@/components/employes/EmployeEditForm"

const TYPE_LABELS: Record<string, string> = {
  VACATION: "Congé payé", SICK: "Maladie", UNPAID: "Congé sans solde",
  TRAINING: "Formation", OTHER: "Autre",
}
const STATUS_STYLE: Record<string, string> = {
  PENDING:  "bg-amber-100 text-amber-700",
  APPROVED: "bg-green-100 text-green-700",
  REJECTED: "bg-red-100 text-red-700",
}

function fmt(d: Date | string) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(d))
}

interface Absence {
  id: string; type: string; status: string
  startDate: Date | string; endDate: Date | string
}
interface Assignment {
  id: string; date: Date | string
  assignment: { worksite: { name: string } }
}
interface DefaultValues {
  firstName: string; lastName: string; email: string
  jobTitle: string; phone: string; hiredAt: string
}

interface Props {
  employeeId: string
  defaultValues: DefaultValues
  absences: Absence[]
  assignments: Assignment[]
}

const TABS = [
  { id: "modifier",     label: "Modifier",     icon: Briefcase   },
  { id: "absences",     label: "Absences",     icon: Calendar    },
  { id: "affectations", label: "Affectations", icon: ClipboardList },
]

export function EmployeeProfileTabs({ employeeId, defaultValues, absences, assignments }: Props) {
  const [active, setActive] = useState("modifier")

  return (
    <div>
      {/* Onglets */}
      <div className="flex gap-1 border-b border-slate-200 mb-4">
        {TABS.map((tab) => {
          const Icon = tab.icon
          const isActive = active === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => setActive(tab.id)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                isActive
                  ? "border-[#0f3460] text-[#0f3460]"
                  : "border-transparent text-slate-500 hover:text-slate-800"
              }`}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* Contenu */}
      {active === "modifier" && (
        <Card>
          <CardContent className="pt-6">
            <EmployeEditForm employeeId={employeeId} defaultValues={defaultValues} />
          </CardContent>
        </Card>
      )}

      {active === "absences" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">Absences ({new Date().getFullYear()})</CardTitle>
          </CardHeader>
          <CardContent>
            {absences.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-6">Aucune absence cette année.</p>
            ) : (
              <div className="space-y-2">
                {absences.map((a) => (
                  <div key={a.id} className="flex items-center justify-between py-2 border-b border-slate-50 last:border-0">
                    <div>
                      <p className="text-xs font-medium text-slate-700">{TYPE_LABELS[a.type] ?? a.type}</p>
                      <p className="text-[11px] text-slate-400">{fmt(a.startDate)} → {fmt(a.endDate)}</p>
                    </div>
                    <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${STATUS_STYLE[a.status] ?? ""}`}>
                      {a.status === "APPROVED" ? "Approuvé" : a.status === "REJECTED" ? "Refusé" : "En attente"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {active === "affectations" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">Affectations ce mois</CardTitle>
          </CardHeader>
          <CardContent>
            {assignments.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-6">Aucune affectation ce mois.</p>
            ) : (
              <div className="divide-y divide-slate-50">
                {assignments.map((ea) => (
                  <div key={ea.id} className="flex items-center justify-between py-2">
                    <p className="text-sm text-slate-700">{ea.assignment.worksite.name}</p>
                    <p className="text-xs text-slate-400">{fmt(ea.date)}</p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
