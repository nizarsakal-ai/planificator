"use client"

import { useState } from "react"
import { LayoutGrid, List } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import Link from "next/link"
import { getInitials } from "@/lib/utils"
import { EmployeActions } from "@/components/employes/EmployeActions"

interface Employee {
  id: string
  firstName: string
  lastName: string
  jobTitle: string | null
  phone: string | null
  active: boolean
  avatarUrl: string | null
  user: { email: string; active: boolean }
  teamMemberships: { team: { name: string; color: string | null } }[]
}

export function EmployesView({ employees }: { employees: Employee[] }) {
  const [view, setView] = useState<"grid" | "list">("grid")

  return (
    <div>
      {/* Toggle */}
      <div className="flex justify-end mb-4">
        <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-1">
          <button
            onClick={() => setView("grid")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              view === "grid" ? "bg-white text-[#0f3460] shadow-sm" : "text-slate-500 hover:text-slate-700"
            }`}
          >
            <LayoutGrid className="h-4 w-4" />
            Mosaïque
          </button>
          <button
            onClick={() => setView("list")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              view === "list" ? "bg-white text-[#0f3460] shadow-sm" : "text-slate-500 hover:text-slate-700"
            }`}
          >
            <List className="h-4 w-4" />
            Liste
          </button>
        </div>
      </div>

      {/* Vue mosaïque */}
      {view === "grid" && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {employees.map((emp) => {
            const fullName = `${emp.firstName} ${emp.lastName}`
            const team = emp.teamMemberships[0]?.team
            return (
              <div key={emp.id} className={`relative group ${!emp.active ? "opacity-50" : ""}`}>
                <Link href={`/employes/${emp.id}`} className="absolute inset-0 z-0 rounded-xl" aria-label={`Voir ${fullName}`} />
                <Card className="hover:shadow-md hover:border-[#0f3460]/30 transition-all border border-slate-100">
                  <CardContent className="p-3 flex flex-col items-center text-center gap-2">
                    <Avatar className="h-11 w-11 mt-1">
                      {emp.avatarUrl && <AvatarImage src={emp.avatarUrl} alt={fullName} />}
                      <AvatarFallback className="bg-[#0f3460] text-white font-semibold text-xs">
                        {getInitials(fullName)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="w-full min-w-0">
                      <p className="font-semibold text-slate-900 text-xs leading-tight truncate group-hover:text-[#0f3460] transition-colors">
                        {fullName}
                      </p>
                      {emp.jobTitle && (
                        <p className="text-[11px] text-slate-400 truncate mt-0.5">{emp.jobTitle}</p>
                      )}
                      {team ? (
                        <div className="flex items-center justify-center gap-1 mt-1">
                          <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: team.color ?? "#0f3460" }} />
                          <span className="text-[11px] text-slate-500 truncate">{team.name}</span>
                        </div>
                      ) : (
                        <p className="text-[10px] text-slate-300 mt-0.5">Sans équipe</p>
                      )}
                    </div>
                    <div className="relative z-10 w-full border-t border-slate-50 pt-2">
                      <EmployeActions employeeId={emp.id} active={emp.active} />
                    </div>
                  </CardContent>
                </Card>
              </div>
            )
          })}
        </div>
      )}

      {/* Vue liste */}
      {view === "list" && (
        <Card>
          <CardContent className="p-0 divide-y divide-slate-50">
            {employees.map((emp) => {
              const fullName = `${emp.firstName} ${emp.lastName}`
              const team = emp.teamMemberships[0]?.team
              return (
                <div key={emp.id} className={`relative group flex items-center gap-3 px-4 py-3 hover:bg-slate-50 transition-colors ${!emp.active ? "opacity-50" : ""}`}>
                  <Link href={`/employes/${emp.id}`} className="absolute inset-0 z-0" aria-label={`Voir ${fullName}`} />
                  <Avatar className="h-9 w-9 shrink-0">
                    {emp.avatarUrl && <AvatarImage src={emp.avatarUrl} alt={fullName} />}
                    <AvatarFallback className="bg-[#0f3460] text-white font-semibold text-xs">
                      {getInitials(fullName)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0 grid grid-cols-4 gap-2 items-center">
                    <p className="font-semibold text-sm text-slate-900 truncate group-hover:text-[#0f3460] transition-colors">
                      {fullName}
                    </p>
                    <p className="text-xs text-slate-400 truncate">{emp.jobTitle ?? "—"}</p>
                    <p className="text-xs text-slate-400 truncate">{emp.phone ?? "—"}</p>
                    <div className="flex items-center gap-1.5">
                      {team ? (
                        <>
                          <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: team.color ?? "#0f3460" }} />
                          <span className="text-xs text-slate-500 truncate">{team.name}</span>
                        </>
                      ) : (
                        <span className="text-xs text-slate-300">Sans équipe</span>
                      )}
                    </div>
                  </div>
                  <Badge variant={emp.active ? "default" : "secondary"} className="text-xs shrink-0 relative z-10">
                    {emp.active ? "Actif" : "Inactif"}
                  </Badge>
                  <div className="relative z-10 shrink-0">
                    <EmployeActions employeeId={emp.id} active={emp.active} />
                  </div>
                </div>
              )
            })}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
