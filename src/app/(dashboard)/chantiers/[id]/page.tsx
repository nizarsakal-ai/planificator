import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect, notFound } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { MapPin, Calendar, Clock, Users, HardHat, FileText, Download } from "lucide-react"
import { ChantierStatusActions } from "@/components/chantiers/ChantierStatusActions"
import { ChantierEditForm } from "@/components/chantiers/ChantierEditForm"
import { AffecterEquipeForm } from "@/components/chantiers/AffecterEquipeForm"
import { DocumentsSection } from "@/components/chantiers/DocumentsSection"
import { DeleteChantierButton } from "@/components/chantiers/DeleteChantierButton"
import { DeleteAssignmentBlockButton } from "@/components/chantiers/DeleteAssignmentBlockButton"
import { RemoveEmployeeFromBlockButton } from "@/components/chantiers/RemoveEmployeeFromBlockButton"
import { AddEmployeeToBlockButton } from "@/components/chantiers/AddEmployeeToBlockButton"
import { groupAssignmentBlocks } from "@/lib/chantiers/assignment-blocks"
import { canShowAffecterEquipeForm } from "@/lib/chantiers/assignment-ui-policy"

export const metadata: Metadata = { title: "Détail chantier" }

const statusLabels: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  PLANNED:     { label: "Planifié",  variant: "secondary" },
  IN_PROGRESS: { label: "En cours", variant: "default" },
  EXTENDED:    { label: "Prolongé", variant: "outline" },
  COMPLETED:   { label: "Terminé",  variant: "secondary" },
  ARCHIVED:    { label: "Archivé",  variant: "secondary" },
  DELAYED:     { label: "Décalé",   variant: "destructive" },
}

function formatDate(date: Date) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long", year: "numeric" }).format(date)
}

function formatDateShort(date: Date) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short" }).format(date)
}

export default async function ChantierDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user) redirect("/login")

  const isAdmin      = ["ADMIN", "SUPER_ADMIN"].includes(session.user.role)
  const isTeamLeader = session.user.role === "TEAM_LEADER"
  const isEmployee   = session.user.role === "EMPLOYEE"
  if (!isAdmin && !isTeamLeader && !isEmployee) redirect("/dashboard")

  let leaderTeamId: string | undefined
  if (isTeamLeader) {
    const leaderEmployee = await prisma.employee.findFirst({
      where: { userId: session.user.id!, companyId: session.user.companyId! },
      select: { ledTeams: { where: { active: true }, select: { id: true }, take: 1 } },
    })
    leaderTeamId = leaderEmployee?.ledTeams[0]?.id
    if (!leaderTeamId) redirect("/dashboard")
  }

  let currentEmployeeId: string | undefined
  if (isEmployee) {
    const emp = await prisma.employee.findFirst({
      where: { userId: session.user.id!, companyId: session.user.companyId! },
      select: { id: true },
    })
    currentEmployeeId = emp?.id
    if (!currentEmployeeId) redirect("/dashboard")
  }

  const [chantier, teams, clients, allEmployees] = await Promise.all([
    prisma.worksite.findFirst({
      where: {
        id,
        companyId: session.user.companyId!,
        ...(isTeamLeader ? { assignments: { some: { teamId: leaderTeamId } } } : {}),
        ...(isEmployee ? { assignments: { some: { employeeAssignments: { some: { employeeId: currentEmployeeId } } } } } : {}),
      },
      include: {
        client: { select: { name: true } },
        assignments: {
          include: {
            team: { select: { name: true, color: true } },
            employeeAssignments: {
              include: {
                employee: { select: { id: true, firstName: true, lastName: true } },
              },
            },
          },
          orderBy: { date: "asc" },
        },
        extensions: { orderBy: { createdAt: "desc" } },
        documents:  { orderBy: { uploadedAt: "desc" } },
      },
    }),
    prisma.team.findMany({
      where: { companyId: session.user.companyId!, active: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.client.findMany({
      where: { companyId: session.user.companyId!, active: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.employee.findMany({
      where: { companyId: session.user.companyId!, active: true },
      select: { id: true, firstName: true, lastName: true },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    }),
  ])

  if (!chantier) notFound()

  const status = statusLabels[chantier.status] ?? { label: chantier.status, variant: "secondary" as const }

  // Calcul des blocs groupés
  const assignmentBlocks = groupAssignmentBlocks(chantier.assignments)

  // Dernier jour couvert + suggestion de relève
  const lastCoveredDate = chantier.assignments.length > 0
    ? chantier.assignments.reduce<Date | null>(
        (max, a) => (!max || a.date > max ? a.date : max),
        null
      )
    : null

  const nextRelayDate = lastCoveredDate && lastCoveredDate < chantier.endDate
    ? new Date(lastCoveredDate.getTime() + 86400000).toISOString().split("T")[0]
    : undefined

  const lastCoveredDateStr = lastCoveredDate?.toISOString().split("T")[0]

  // Timeline : largeur totale du chantier en jours
  const totalMs   = chantier.endDate.getTime() - chantier.startDate.getTime() + 86400000
  const totalDays = totalMs / 86400000

  return (
    <div className="space-y-6">
      {/* En-tête */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-slate-100 flex items-center justify-center">
            <HardHat className="h-6 w-6 text-slate-500" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">{chantier.name}</h1>
            <p className="text-sm text-slate-500">{chantier.client.name}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <DeleteChantierButton worksiteId={chantier.id} worksiteName={chantier.name} />
          )}
          <a
            href={`/api/pdf/chantier/${chantier.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
          >
            <Download className="h-4 w-4" />
            Export PDF
          </a>
          <Badge variant={status.variant} className="text-sm px-3 py-1">{status.label}</Badge>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Colonne gauche — infos + actions */}
        <div className="lg:col-span-1 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold text-slate-700">Informations</CardTitle>
                {isAdmin && (
                  <ChantierEditForm
                    worksiteId={chantier.id}
                    clients={clients}
                    defaultValues={{
                      name:        chantier.name,
                      description: chantier.description ?? "",
                      address:     chantier.address     ?? "",
                      clientId:    chantier.clientId,
                      startDate:   chantier.startDate.toISOString().split("T")[0],
                      endDate:     chantier.endDate.toISOString().split("T")[0],
                      dailyHours:  chantier.dailyHours,
                    }}
                  />
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {chantier.address && (
                <div className="flex items-start gap-2 text-sm text-slate-600">
                  <MapPin className="h-4 w-4 shrink-0 mt-0.5 text-slate-400" />
                  {chantier.address}
                </div>
              )}
              <div className="flex items-center gap-2 text-sm text-slate-600">
                <Calendar className="h-4 w-4 shrink-0 text-slate-400" />
                <span>{formatDate(chantier.startDate)}</span>
                <span className="text-slate-300">→</span>
                <span>{formatDate(chantier.endDate)}</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-slate-600">
                <Clock className="h-4 w-4 shrink-0 text-slate-400" />
                {chantier.dailyHours}h / jour
              </div>
              {chantier.description && (
                <div className="flex items-start gap-2 text-sm text-slate-600">
                  <FileText className="h-4 w-4 shrink-0 mt-0.5 text-slate-400" />
                  <span className="whitespace-pre-wrap">{chantier.description}</span>
                </div>
              )}
            </CardContent>
          </Card>

          {isAdmin && (
            <ChantierStatusActions
              worksiteId={chantier.id}
              currentStatus={chantier.status}
              endDate={chantier.endDate}
            />
          )}
        </div>

        {/* Colonne droite — affectations */}
        <div className="lg:col-span-2 space-y-4">
          {/* Formulaire d'affectation — visible ADMIN/SUPER_ADMIN sauf ARCHIVED
              (y compris COMPLETED / endDate passée : correction après auto-complete cron) */}
          {canShowAffecterEquipeForm({ role: session.user.role, status: chantier.status }) && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold text-slate-700">
                  Affecter une équipe
                </CardTitle>
              </CardHeader>
              <CardContent>
                <AffecterEquipeForm
                  worksiteId={chantier.id}
                  teams={teams}
                  worksiteStartDate={chantier.startDate.toISOString().split("T")[0]}
                  worksiteEndDate={chantier.endDate.toISOString().split("T")[0]}
                  nextRelayDate={nextRelayDate}
                  lastCoveredDate={lastCoveredDateStr}
                />
              </CardContent>
            </Card>
          )}

          {/* Planning des équipes */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                <Users className="h-4 w-4" />
                Planning des équipes
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Timeline visuelle */}
              {assignmentBlocks.length > 0 && (
                <div className="space-y-1.5">
                  <div className="flex justify-between text-[10px] text-slate-400 px-0.5">
                    <span>{formatDateShort(chantier.startDate)}</span>
                    <span>{formatDateShort(chantier.endDate)}</span>
                  </div>
                  <div className="relative h-7 bg-slate-100 rounded-lg overflow-hidden">
                    {/* Barre grise "non couvert" visible en fond */}
                    {[...assignmentBlocks]
                      .sort((a, b) => a.startDate.getTime() - b.startDate.getTime())
                      .map((block, i) => {
                        const left  = Math.max(0, (block.startDate.getTime() - chantier.startDate.getTime()) / (totalDays * 86400000) * 100)
                        const width = Math.min(100 - left, (block.dayCount / totalDays) * 100)
                        return (
                          <div
                            key={`tl-${block.teamId}-${i}`}
                            className="absolute h-full flex items-center justify-center text-[10px] font-semibold text-white overflow-hidden"
                            style={{
                              left:            `${left}%`,
                              width:           `${Math.max(width, 0.5)}%`,
                              backgroundColor: block.teamColor ?? "#0f3460",
                              opacity:         0.85,
                            }}
                            title={`${block.teamName} : ${formatDateShort(block.startDate)} → ${formatDateShort(block.endDate)}`}
                          >
                            {width > 12 ? block.teamName : ""}
                          </div>
                        )
                      })}
                  </div>
                  {/* Légende équipes */}
                  <div className="flex flex-wrap gap-2 pt-0.5">
                    {[...new Map(assignmentBlocks.map((b) => [b.teamId, b])).values()].map((b) => (
                      <span key={b.teamId} className="flex items-center gap-1 text-[11px] text-slate-500">
                        <span
                          className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
                          style={{ backgroundColor: b.teamColor ?? "#0f3460" }}
                        />
                        {b.teamName}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Liste des blocs */}
              {assignmentBlocks.length === 0 ? (
                <p className="text-sm text-slate-400 text-center py-6">
                  Aucune affectation pour ce chantier.
                </p>
              ) : (
                <div className="space-y-3">
                  {assignmentBlocks.map((block, i) => (
                    <div
                      key={`${block.teamId}-${i}`}
                      className="p-3 rounded-lg border border-slate-100 bg-slate-50/50 space-y-2"
                    >
                      {/* En-tête du bloc */}
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className="inline-block w-3 h-3 rounded-full shrink-0"
                            style={{ backgroundColor: block.teamColor ?? "#0f3460" }}
                          />
                          <span className="text-sm font-semibold text-slate-800 truncate">
                            {block.teamName}
                          </span>
                          <span className="text-xs text-slate-400 shrink-0">
                            {block.dayCount} jour{block.dayCount > 1 ? "s" : ""}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Badge
                            variant={
                              block.status === "CONFIRMED" ? "default"
                              : block.status === "REFUSED" ? "destructive"
                              : "secondary"
                            }
                            className="text-xs"
                          >
                            {block.status === "CONFIRMED" ? "Confirmé"
                              : block.status === "REFUSED" ? "Refusé"
                              : "En attente"}
                          </Badge>
                          {isAdmin && (
                            <DeleteAssignmentBlockButton
                              worksiteId={chantier.id}
                              teamId={block.teamId}
                              teamName={block.teamName}
                              startDate={block.startDate.toISOString().split("T")[0]}
                              endDate={block.endDate.toISOString().split("T")[0]}
                              dayCount={block.dayCount}
                            />
                          )}
                        </div>
                      </div>

                      {/* Plage de dates */}
                      <div className="flex items-center gap-1.5 text-xs text-slate-500">
                        <Calendar className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                        <span>
                          {block.dayCount === 1
                            ? formatDate(block.startDate)
                            : `${formatDate(block.startDate)} → ${formatDate(block.endDate)}`}
                        </span>
                      </div>

                      {/* Membres */}
                      <div className="flex flex-wrap gap-1.5 pl-5 items-center">
                        {block.employees.map((emp) => (
                          <span
                            key={emp.id}
                            className="inline-flex items-center gap-1 bg-white border border-slate-200 text-slate-600 text-[11px] font-medium px-2 py-0.5 rounded-full"
                          >
                            {emp.firstName} {emp.lastName}
                            {isAdmin && (
                              <RemoveEmployeeFromBlockButton
                                worksiteId={chantier.id}
                                teamId={block.teamId}
                                startDate={block.startDate.toISOString().split("T")[0]}
                                endDate={block.endDate.toISOString().split("T")[0]}
                                employeeId={emp.id}
                                employeeName={`${emp.firstName} ${emp.lastName}`}
                              />
                            )}
                          </span>
                        ))}
                        {isAdmin && (
                          <AddEmployeeToBlockButton
                            worksiteId={chantier.id}
                            teamId={block.teamId}
                            startDate={block.startDate.toISOString().split("T")[0]}
                            endDate={block.endDate.toISOString().split("T")[0]}
                            currentEmployeeIds={block.employees.map((e) => e.id)}
                            allEmployees={allEmployees}
                          />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Prolongations */}
          {chantier.extensions.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold text-slate-700">Prolongations</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {chantier.extensions.map((ext) => (
                    <div key={ext.id} className="text-sm py-2 border-b border-slate-50 last:border-0">
                      <p className="text-slate-700">
                        {formatDate(ext.previousEndDate)} → {formatDate(ext.newEndDate)}
                      </p>
                      {ext.reason && <p className="text-xs text-slate-400 mt-0.5">{ext.reason}</p>}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Photos, Plans & Documents */}
          <DocumentsSection worksiteId={chantier.id} documents={chantier.documents} />
        </div>
      </div>
    </div>
  )
}
