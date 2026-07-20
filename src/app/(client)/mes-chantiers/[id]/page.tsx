import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect, notFound } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { MapPin, Calendar, Clock, Users, FileText, ArrowLeft, CheckCircle2, XCircle, Clock3 } from "lucide-react"
import Link from "next/link"
import Image from "next/image"

export const metadata: Metadata = { title: "Détail chantier" }

const STATUS_STYLE: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline"; color: string }> = {
  PLANNED:     { label: "Planifié",   variant: "secondary", color: "#3b82f6" },
  IN_PROGRESS: { label: "En cours",  variant: "default",   color: "#22c55e" },
  EXTENDED:    { label: "Prolongé",  variant: "outline",   color: "#f59e0b" },
  COMPLETED:   { label: "Terminé",   variant: "secondary", color: "#6b7280" },
  ARCHIVED:    { label: "Archivé",   variant: "secondary", color: "#374151" },
}

function formatDate(d: Date) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long", year: "numeric" }).format(d)
}

function formatDay(d: Date) {
  return new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "2-digit", month: "long" }).format(d)
}

function progressPercent(start: Date, end: Date): number {
  const now   = Date.now()
  const s     = new Date(start).getTime()
  const e     = new Date(end).getTime()
  if (now <= s) return 0
  if (now >= e) return 100
  return Math.round(((now - s) / (e - s)) * 100)
}

export default async function ClientChantierDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (session.user.role !== "CLIENT") redirect("/dashboard")

  const clientRecord = await prisma.client.findFirst({
    where: { companyId: session.user.companyId!, email: session.user.email! },
  })
  if (!clientRecord) notFound()

  const chantier = await prisma.worksite.findFirst({
    where: { id, clientId: clientRecord.id },
    include: {
      assignments: {
        include: { team: { select: { name: true } } },
        orderBy: { date: "asc" },
      },
      documents: { orderBy: { uploadedAt: "desc" } },
    },
  })
  if (!chantier) notFound()

  const st = STATUS_STYLE[chantier.status] ?? { label: chantier.status, variant: "secondary" as const, color: "#6b7280" }
  const progress = progressPercent(chantier.startDate, chantier.endDate)

  const confirmed = chantier.assignments.filter(a => a.status === "CONFIRMED")
  const pending   = chantier.assignments.filter(a => a.status === "PENDING")
  const upcoming  = chantier.assignments.filter(a => new Date(a.date) >= new Date() && a.status !== "REFUSED")

  const photos    = chantier.documents.filter(d => d.type === "PHOTO")
  const plans     = chantier.documents.filter(d => d.type === "PLAN")
  const docs      = chantier.documents.filter(d => d.type === "DOCUMENT")

  function resolveDocumentUrl(doc: {
    url: string | null
    sourceAcquisitionAttachmentId: string | null
  }): string | null {
    if (doc.sourceAcquisitionAttachmentId) {
      return `/api/acquisition/attachments/${doc.sourceAcquisitionAttachmentId}`
    }
    return doc.url
  }

  return (
    <div className="space-y-6">
      {/* Retour */}
      <Link href="/mes-chantiers" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors">
        <ArrowLeft className="h-4 w-4" /> Mes chantiers
      </Link>

      {/* En-tête */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{chantier.name}</h1>
          {chantier.address && (
            <p className="text-sm text-slate-500 flex items-center gap-1 mt-1">
              <MapPin className="h-3.5 w-3.5" /> {chantier.address}
            </p>
          )}
        </div>
        <Badge variant={st.variant} className="text-sm px-3 py-1">{st.label}</Badge>
      </div>

      {/* Progression */}
      {["IN_PROGRESS", "EXTENDED"].includes(chantier.status) && (
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-medium text-slate-700">Avancement</p>
              <p className="text-sm font-bold text-slate-900">{progress}%</p>
            </div>
            <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${progress}%`, backgroundColor: st.color }}
              />
            </div>
            <div className="flex justify-between mt-1.5">
              <p className="text-xs text-slate-400">{formatDate(chantier.startDate)}</p>
              <p className="text-xs text-slate-400">{formatDate(chantier.endDate)}</p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Infos */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-slate-700">Informations</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-slate-600">
              <Calendar className="h-4 w-4 text-slate-400 shrink-0" />
              <span>{formatDate(chantier.startDate)}</span>
              <span className="text-slate-300">→</span>
              <span>{formatDate(chantier.endDate)}</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-slate-600">
              <Clock className="h-4 w-4 text-slate-400 shrink-0" />
              {chantier.dailyHours}h / jour
            </div>
            {chantier.description && (
              <div className="flex items-start gap-2 text-sm text-slate-600">
                <FileText className="h-4 w-4 text-slate-400 shrink-0 mt-0.5" />
                <span className="whitespace-pre-wrap leading-relaxed">{chantier.description}</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Résumé chiffres */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-slate-700">Résumé</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2 text-slate-600">
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                Interventions confirmées
              </div>
              <span className="font-bold text-slate-900">{confirmed.length}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2 text-slate-600">
                <Clock3 className="h-4 w-4 text-blue-500" />
                En attente de confirmation
              </div>
              <span className="font-bold text-slate-900">{pending.length}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2 text-slate-600">
                <Calendar className="h-4 w-4 text-slate-400" />
                Prochaines interventions
              </div>
              <span className="font-bold text-slate-900">{upcoming.length}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2 text-slate-600">
                <FileText className="h-4 w-4 text-slate-400" />
                Documents
              </div>
              <span className="font-bold text-slate-900">{chantier.documents.length}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Prochaines interventions */}
      {upcoming.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              <Calendar className="h-4 w-4 text-blue-500" />
              Prochaines interventions
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {upcoming.slice(0, 5).map((a) => (
                <div key={a.id} className="flex items-center justify-between py-2 border-b border-slate-50 last:border-0">
                  <div className="flex items-center gap-2 text-sm text-slate-700">
                    <Users className="h-4 w-4 text-slate-400" />
                    <div>
                      <p className="font-medium">{a.team.name}</p>
                      <p className="text-xs text-slate-400">{formatDay(a.date)}</p>
                    </div>
                  </div>
                  <Badge
                    variant={a.status === "CONFIRMED" ? "default" : "secondary"}
                    className="text-xs"
                  >
                    {a.status === "CONFIRMED" ? "Confirmé" : "En attente"}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Historique des interventions */}
      {chantier.assignments.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              <Users className="h-4 w-4" />
              Historique des interventions ({chantier.assignments.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {chantier.assignments.map((a) => (
                <div key={a.id} className="flex items-center justify-between py-2 border-b border-slate-50 last:border-0">
                  <div>
                    <p className="text-sm font-medium text-slate-800">{a.team.name}</p>
                    <p className="text-xs text-slate-400">{formatDay(a.date)}</p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {a.status === "CONFIRMED" && <CheckCircle2 className="h-4 w-4 text-green-500" />}
                    {a.status === "REFUSED"   && <XCircle      className="h-4 w-4 text-red-400"   />}
                    {a.status === "PENDING"   && <Clock3       className="h-4 w-4 text-blue-400"  />}
                    <span className={`text-xs font-medium ${
                      a.status === "CONFIRMED" ? "text-green-600" :
                      a.status === "REFUSED"   ? "text-red-500"   : "text-blue-500"
                    }`}>
                      {a.status === "CONFIRMED" ? "Confirmé" : a.status === "REFUSED" ? "Refusé" : "En attente"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Photos */}
      {photos.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-slate-700">Photos du chantier</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {photos.map((p) => {
                const href = resolveDocumentUrl(p)
                if (!href) return null
                return (
                  <a key={p.id} href={href} target="_blank" rel="noopener noreferrer">
                    <div className="aspect-video rounded-lg overflow-hidden bg-slate-100 hover:opacity-90 transition-opacity">
                      <Image src={href} alt={p.name} width={300} height={200} className="w-full h-full object-cover" />
                    </div>
                  </a>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Plans & Documents */}
      {(plans.length > 0 || docs.length > 0) && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-slate-700">Plans & Documents</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {[...plans, ...docs].map((d) => {
                const href = resolveDocumentUrl(d)
                if (!href) return null
                return (
                <a
                  key={d.id}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 p-3 rounded-lg border border-slate-100 hover:bg-slate-50 transition-colors"
                >
                  <FileText className="h-4 w-4 text-slate-400 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-700 truncate">{d.name}</p>
                    <p className="text-xs text-slate-400">{d.type === "PLAN" ? "Plan" : "Document"}</p>
                  </div>
                </a>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
