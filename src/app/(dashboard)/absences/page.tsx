import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Card, CardContent } from "@/components/ui/card"
import { CalendarOff, CheckCircle2, Clock3, XCircle } from "lucide-react"
import { NouvelleAbsenceDialog } from "@/components/absences/NouvelleAbsenceDialog"
import { AbsenceFilters } from "@/components/absences/AbsenceFilters"

export const metadata: Metadata = { title: "Absences" }

const TYPE_LABELS: Record<string, string> = {
  VACATION: "Congé payé",
  SICK:     "Maladie",
  UNPAID:   "Congé sans solde",
  TRAINING: "Formation",
  OTHER:    "Autre",
}

export default async function AbsencesPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) redirect("/dashboard")

  const companyId = session.user.companyId!

  const [absences, employees] = await Promise.all([
    prisma.absence.findMany({
      where: { companyId },
      include: { employee: { select: { firstName: true, lastName: true } } },
      orderBy: { startDate: "desc" },
    }),
    prisma.employee.findMany({
      where: { companyId, active: true },
      select: { id: true, firstName: true, lastName: true },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    }),
  ])

  const pending  = absences.filter((a) => a.status === "PENDING").length
  const approved = absences.filter((a) => a.status === "APPROVED").length
  const rejected = absences.filter((a) => a.status === "REJECTED").length

  // Stats : jours approuvés par type (année en cours)
  const yearStart = new Date(new Date().getFullYear(), 0, 1)
  const approvedThisYear = absences.filter(
    (a) => a.status === "APPROVED" && a.startDate >= yearStart
  )
  const daysByType: Record<string, number> = {}
  for (const a of approvedThisYear) {
    const days = Math.round((a.endDate.getTime() - a.startDate.getTime()) / 86_400_000) + 1
    daysByType[a.type] = (daysByType[a.type] ?? 0) + days
  }

  return (
    <div className="space-y-6">
      {/* En-tête */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Absences</h1>
          <p className="text-sm text-slate-500 mt-1">
            {pending} en attente · {approved} approuvée{approved > 1 ? "s" : ""} · {rejected} refusée{rejected > 1 ? "s" : ""}
          </p>
        </div>
        <NouvelleAbsenceDialog employees={employees} />
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-amber-50 flex items-center justify-center shrink-0">
              <Clock3 className="h-5 w-5 text-amber-500" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{pending}</p>
              <p className="text-xs text-slate-500">En attente</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-green-50 flex items-center justify-center shrink-0">
              <CheckCircle2 className="h-5 w-5 text-green-500" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{approved}</p>
              <p className="text-xs text-slate-500">Approuvées</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-red-50 flex items-center justify-center shrink-0">
              <XCircle className="h-5 w-5 text-red-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{rejected}</p>
              <p className="text-xs text-slate-500">Refusées</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Stats par type (année en cours) */}
      {Object.keys(daysByType).length > 0 && (
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-semibold text-slate-500 mb-3 uppercase tracking-wide">
              Jours approuvés — {new Date().getFullYear()}
            </p>
            <div className="flex flex-wrap gap-3">
              {Object.entries(daysByType).map(([type, days]) => (
                <div key={type} className="flex items-center gap-2 bg-slate-50 rounded-lg px-3 py-2">
                  <CalendarOff className="h-3.5 w-3.5 text-slate-400" />
                  <span className="text-xs text-slate-600 font-medium">{TYPE_LABELS[type] ?? type}</span>
                  <span className="text-xs font-bold text-slate-800">{days}j</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Liste filtrée */}
      <AbsenceFilters absences={absences} employees={employees} />
    </div>
  )
}
