import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { CalendarOff } from "lucide-react"
import { NouvelleAbsenceDialog } from "@/components/absences/NouvelleAbsenceDialog"
import { AbsenceActions } from "@/components/absences/AbsenceActions"

export const metadata: Metadata = { title: "Absences" }

const TYPE_LABELS: Record<string, string> = {
  VACATION: "Congé payé",
  SICK:     "Maladie",
  UNPAID:   "Congé sans solde",
  TRAINING: "Formation",
  OTHER:    "Autre",
}

const STATUS_STYLE: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  PENDING:  { label: "En attente", variant: "secondary" },
  APPROVED: { label: "Approuvé",   variant: "default" },
  REJECTED: { label: "Refusé",     variant: "destructive" },
}

function formatDate(d: Date) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", year: "numeric" }).format(d)
}

function diffDays(start: Date, end: Date) {
  return Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1
}

export default async function AbsencesPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) redirect("/dashboard")

  const [absences, employees] = await Promise.all([
    prisma.absence.findMany({
      where: { companyId: session.user.companyId! },
      include: { employee: { select: { firstName: true, lastName: true } } },
      orderBy: { startDate: "desc" },
    }),
    prisma.employee.findMany({
      where: { companyId: session.user.companyId!, active: true },
      select: { id: true, firstName: true, lastName: true },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    }),
  ])

  const pending  = absences.filter((a) => a.status === "PENDING").length
  const approved = absences.filter((a) => a.status === "APPROVED").length

  return (
    <div className="space-y-6">
      {/* En-tête */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Absences</h1>
          <p className="text-sm text-slate-500 mt-1">
            {pending} en attente · {approved} approuvée{approved > 1 ? "s" : ""}
          </p>
        </div>
        <NouvelleAbsenceDialog employees={employees} />
      </div>

      {/* Liste */}
      {absences.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <CalendarOff className="h-10 w-10 text-slate-200 mx-auto mb-3" />
            <p className="text-slate-400 font-medium">Aucune absence enregistrée.</p>
            <p className="text-slate-400 text-sm mt-1">Cliquez sur &quot;Nouvelle absence&quot; pour commencer.</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="divide-y divide-slate-50">
              {absences.map((absence) => {
                const st = STATUS_STYLE[absence.status] ?? { label: absence.status, variant: "secondary" as const }
                const days = diffDays(absence.startDate, absence.endDate)
                return (
                  <div key={absence.id} className="flex items-center justify-between px-5 py-3 hover:bg-slate-50 transition-colors">
                    <div className="flex items-center gap-4">
                      {/* Avatar */}
                      <div className="w-9 h-9 rounded-full bg-slate-100 flex items-center justify-center text-xs font-bold text-slate-600 shrink-0">
                        {absence.employee.firstName[0]}{absence.employee.lastName[0]}
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-slate-800">
                          {absence.employee.firstName} {absence.employee.lastName}
                        </p>
                        <p className="text-xs text-slate-500">
                          {TYPE_LABELS[absence.type] ?? absence.type} · {formatDate(absence.startDate)} → {formatDate(absence.endDate)} ({days}j)
                        </p>
                        {absence.reason && <p className="text-xs text-slate-400 mt-0.5 italic">{absence.reason}</p>}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Badge variant={st.variant} className="text-xs">{st.label}</Badge>
                      <AbsenceActions absenceId={absence.id} status={absence.status} />
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
