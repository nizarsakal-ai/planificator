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

export const metadata: Metadata = { title: "Détail chantier" }

const statusLabels: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  PLANNED:     { label: "Planifié",    variant: "secondary" },
  IN_PROGRESS: { label: "En cours",   variant: "default" },
  EXTENDED:    { label: "Prolongé",   variant: "outline" },
  COMPLETED:   { label: "Terminé",    variant: "secondary" },
  ARCHIVED:    { label: "Archivé",    variant: "secondary" },
}

function formatDate(date: Date) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long", year: "numeric" }).format(date)
}

export default async function ChantierDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) redirect("/dashboard")

  const [chantier, teams, clients] = await Promise.all([
    prisma.worksite.findFirst({
      where: { id, companyId: session.user.companyId! },
      include: {
        client: { select: { name: true } },
        assignments: {
          include: {
            team: { select: { name: true } },
          },
          orderBy: { date: "desc" },
          take: 20,
        },
        extensions: {
          orderBy: { createdAt: "desc" },
        },
        documents: {
          orderBy: { uploadedAt: "desc" },
        },
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
  ])

  if (!chantier) notFound()

  const status = statusLabels[chantier.status] ?? { label: chantier.status, variant: "secondary" as const }

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
          {/* Infos générales */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold text-slate-700">Informations</CardTitle>
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

          {/* Actions statut */}
          <ChantierStatusActions worksiteId={chantier.id} currentStatus={chantier.status} endDate={chantier.endDate} />
        </div>

        {/* Colonne droite — affectations */}
        <div className="lg:col-span-2 space-y-4">
          {/* Affecter une équipe */}
          {!["COMPLETED", "ARCHIVED"].includes(chantier.status) && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold text-slate-700">Affecter une équipe</CardTitle>
              </CardHeader>
              <CardContent>
                <AffecterEquipeForm worksiteId={chantier.id} teams={teams} />
              </CardContent>
            </Card>
          )}

          {/* Historique des affectations */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                <Users className="h-4 w-4" />
                Affectations
              </CardTitle>
            </CardHeader>
            <CardContent>
              {chantier.assignments.length === 0 ? (
                <p className="text-sm text-slate-400 text-center py-6">Aucune affectation pour ce chantier.</p>
              ) : (
                <div className="space-y-2">
                  {chantier.assignments.map((a) => (
                    <div key={a.id} className="flex items-center justify-between py-2 border-b border-slate-50 last:border-0">
                      <div>
                        <p className="text-sm font-medium text-slate-800">{a.team.name}</p>
                        <p className="text-xs text-slate-400">
                          {new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "2-digit", month: "long" }).format(a.date)}
                        </p>
                      </div>
                      <Badge
                        variant={a.status === "CONFIRMED" ? "default" : a.status === "REFUSED" ? "destructive" : "secondary"}
                        className="text-xs"
                      >
                        {a.status === "CONFIRMED" ? "Confirmé" : a.status === "REFUSED" ? "Refusé" : "En attente"}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Extensions */}
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
          <DocumentsSection
            worksiteId={chantier.id}
            documents={chantier.documents}
          />
        </div>
      </div>
    </div>
  )
}
