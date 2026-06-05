import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { HardHat, MapPin, Clock, Calendar, Users, CheckCircle2, XCircle, Clock3, FileText } from "lucide-react"
import { AssignmentActions } from "@/components/planning/AssignmentActions"
import { DailyReportDialog } from "@/components/planning/DailyReportDialog"
import { SignaturePad } from "@/components/planning/SignaturePad"

export const metadata: Metadata = { title: "Planning équipe" }

const STATUS_STYLE: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  CONFIRMED: { label: "Confirmé",   variant: "default" },
  PENDING:   { label: "En attente", variant: "secondary" },
  REFUSED:   { label: "Refusé",     variant: "destructive" },
}

function formatDay(d: Date) {
  return new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "2-digit", month: "long", year: "numeric" }).format(d)
}

export default async function PlanningEquipePage() {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (session.user.role !== "TEAM_LEADER") redirect("/dashboard")

  // Trouver l'employé lié à ce chef d'équipe
  const employee = await prisma.employee.findFirst({
    where: { userId: session.user.id },
    select: { id: true, firstName: true, lastName: true },
  })
  if (!employee) redirect("/dashboard")

  // Trouver l'équipe dont il est chef
  const team = await prisma.team.findFirst({
    where: { leaderId: employee.id, companyId: session.user.companyId! },
    select: { id: true, name: true },
  })

  if (!team) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-slate-900">Planning équipe</h1>
        <Card>
          <CardContent className="py-16 text-center">
            <Users className="h-10 w-10 text-slate-200 mx-auto mb-3" />
            <p className="text-slate-400 font-medium">Vous n&apos;êtes chef d&apos;aucune équipe.</p>
            <p className="text-slate-400 text-sm mt-1">Contactez votre administrateur.</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Récupérer les affectations de l'équipe (30j passés + 60j futurs)
  const from = new Date(); from.setDate(from.getDate() - 30); from.setHours(0,0,0,0)
  const to   = new Date(); to.setDate(to.getDate() + 60);     to.setHours(23,59,59,999)

  const [assignments, dailyReports] = await Promise.all([
    prisma.assignment.findMany({
      where: {
        teamId: team.id,
        date:   { gte: from, lte: to },
      },
      include: {
        worksite: { select: { id: true, name: true, address: true, dailyHours: true } },
        employeeAssignments: {
          include: {
            employee: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
          },
        },
        signature: true,
      },
      orderBy: { date: "asc" },
    }),
    prisma.dailyReport.findMany({
      where: { teamId: team.id, date: { gte: from, lte: to } },
    }),
  ])

  const today    = new Date(); today.setHours(0,0,0,0)
  const upcoming = assignments.filter(a => new Date(a.date) >= today)
  const past     = assignments.filter(a => new Date(a.date) <  today)

  const pendingCount   = upcoming.filter(a => a.status === "PENDING").length
  const confirmedCount = upcoming.filter(a => a.status === "CONFIRMED").length

  return (
    <div className="space-y-6">
      {/* En-tête */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Planning — {team.name}</h1>
        <p className="text-sm text-slate-500 mt-1">
          {employee.firstName} {employee.lastName} · Chef d&apos;équipe
        </p>
      </div>

      {/* Stats rapides */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-amber-50 flex items-center justify-center">
              <Clock3 className="h-4.5 w-4.5 text-amber-500 h-5 w-5" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{pendingCount}</p>
              <p className="text-xs text-slate-500">En attente</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-green-50 flex items-center justify-center">
              <CheckCircle2 className="h-5 w-5 text-green-500" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{confirmedCount}</p>
              <p className="text-xs text-slate-500">Confirmées</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center">
              <Calendar className="h-5 w-5 text-slate-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{upcoming.length}</p>
              <p className="text-xs text-slate-500">À venir</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* À venir */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide flex items-center gap-2">
          Affectations à venir
          {pendingCount > 0 && (
            <span className="inline-flex items-center justify-center h-5 px-1.5 rounded-full bg-amber-100 text-amber-700 text-[11px] font-bold">
              {pendingCount} à confirmer
            </span>
          )}
        </h2>

        {upcoming.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Calendar className="h-8 w-8 text-slate-200 mx-auto mb-2" />
              <p className="text-slate-400 text-sm">Aucune affectation prévue.</p>
            </CardContent>
          </Card>
        ) : (
          upcoming.map((a) => {
            const st = STATUS_STYLE[a.status] ?? { label: a.status, variant: "secondary" as const }
            const isPending = a.status === "PENDING"
            return (
              <Card
                key={a.id}
                className={`border-l-4 ${
                  isPending       ? "border-l-amber-400" :
                  a.status === "CONFIRMED" ? "border-l-green-500" : "border-l-red-400"
                }`}
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1.5 flex-1">
                      <div className="flex items-center gap-2">
                        <HardHat className="h-4 w-4 text-[#0f3460] shrink-0" />
                        <p className="font-semibold text-slate-800 text-sm">{a.worksite.name}</p>
                      </div>
                      <p className="text-xs text-slate-500 font-medium capitalize">{formatDay(a.date)}</p>
                      {a.worksite.address && (
                        <div className="flex items-center gap-1.5 text-xs text-slate-500">
                          <MapPin className="h-3.5 w-3.5 shrink-0" />
                          {a.worksite.address}
                        </div>
                      )}
                      <div className="flex items-center gap-1.5 text-xs text-slate-500">
                        <Clock className="h-3.5 w-3.5 shrink-0" />
                        {a.worksite.dailyHours}h / jour
                      </div>
                      {/* Membres affectés */}
                      {a.employeeAssignments.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {a.employeeAssignments.map((ea) => (
                            <span
                              key={ea.employee.id}
                              className="inline-flex items-center gap-1 bg-slate-100 text-slate-700 text-[11px] font-medium px-2 py-0.5 rounded-full"
                            >
                              <Users className="h-3 w-3 shrink-0" />
                              {ea.employee.firstName} {ea.employee.lastName}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <Badge variant={st.variant} className="text-xs shrink-0">{st.label}</Badge>
                  </div>

                  {/* Boutons confirmer/refuser uniquement si en attente */}
                  {isPending && <AssignmentActions assignmentId={a.id} />}

                  {/* Raison du refus */}
                  {a.status === "REFUSED" && a.refusalReason && (
                    <div className="mt-2 p-2 bg-red-50 rounded text-xs text-red-600 flex items-start gap-1.5">
                      <XCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                      {a.refusalReason}
                    </div>
                  )}

                  {/* Rapport journalier — uniquement pour les affectations confirmées */}
                  {a.status === "CONFIRMED" && (
                    <DailyReportDialog
                      worksiteId={a.worksite.id}
                      worksiteName={a.worksite.name}
                      teamId={team.id}
                      date={a.date.toISOString().split("T")[0]}
                      dailyHours={a.worksite.dailyHours}
                      existingReport={dailyReports.find(r => r.date.toISOString().split("T")[0] === a.date.toISOString().split("T")[0]) ?? null}
                    />
                  )}

                  {/* Signature électronique — uniquement pour les affectations confirmées */}
                  {a.status === "CONFIRMED" && (
                    <SignaturePad
                      assignmentId={a.id}
                      worksiteName={a.worksite.name}
                      date={a.date.toISOString().split("T")[0]}
                      isSigned={!!a.signature}
                      existingSignatureUrl={a.signature?.signatureUrl ?? null}
                    />
                  )}

                  {/* Lien PDF feuille de présence signée */}
                  {a.status === "CONFIRMED" && a.signature && (
                    <a
                      href={`/api/pdf/signature/${a.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 transition-colors"
                    >
                      <FileText className="h-3.5 w-3.5" />
                      Télécharger la feuille signée (PDF)
                    </a>
                  )}
                </CardContent>
              </Card>
            )
          })
        )}
      </div>

      {/* Historique */}
      {past.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wide">Historique</h2>
          {[...past].reverse().map((a) => {
            const st = STATUS_STYLE[a.status] ?? { label: a.status, variant: "secondary" as const }
            return (
              <Card key={a.id} className="opacity-60">
                <CardContent className="p-4 flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <HardHat className="h-4 w-4 text-slate-400" />
                      <p className="font-medium text-slate-600 text-sm">{a.worksite.name}</p>
                    </div>
                    <p className="text-xs text-slate-400 capitalize">{formatDay(a.date)}</p>
                  </div>
                  <Badge variant={st.variant} className="text-xs shrink-0">{st.label}</Badge>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
