// Lot D Planificator V2 : réserves d'un chantier (constat avec preuves, levée, annulation) et procès-verbaux de
// réception (signature du client, instantané figé, PDF reproductible). Drapeau WORKSITE_RESERVES_ENABLED +
// ADMIN/SUPER_ADMIN ; un chantier d'une autre entreprise donne 404.
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft, ClipboardCheck, FileDown, Paperclip } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { reservePageAccess } from "@/lib/reserves/access"
import { AdminOnlyNotice } from "@/components/stock/AdminOnlyNotice"
import { getWorksiteReception } from "@/lib/reserves/queries"
import { DECISION_LABEL, DECISIONS, MAX_LISTED_RESERVES, MAX_REPORT_RESERVES, SEVERITIES, SEVERITY_LABEL, STATUS_LABEL } from "@/lib/reserves/reserves.core"
import { formatDay, parisToday } from "@/lib/equipment/equipment.core"
import { serverNow } from "@/lib/billing/clock"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { SELECT_CLASS } from "@/components/stock/StockFlash"
import { fmtDay, fmtInstant } from "@/components/equipment/labels"
import { DECISION_CLASS, RESERVE_STATUS_CLASS, SEVERITY_CLASS } from "@/components/reserves/labels"
import { ReportSignatureField, ReserveFlash, ReserveForm, ReserveFormsProvider } from "@/components/reserves/ReserveForms"

const ID = /^[A-Za-z0-9_-]{1,64}$/
const FILE_ACCEPT = "image/jpeg,image/png,image/webp,application/pdf"
const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} Ko`

export default async function WorksiteReservesPage({ params, searchParams }: { params: Promise<{ worksiteId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await reservePageAccess()
  // Rôle ou société non habilités : refus rendu sur place, avant toute lecture métier.
  if (!ctx) return <AdminOnlyNotice />
  const { worksiteId } = await params
  if (!ID.test(worksiteId)) notFound()
  await searchParams   // rendu dynamique conservé ; le message (?ok= / ?erreur=) est lu par ReserveFlash
  const data = await getWorksiteReception(prisma, ctx.companyId, worksiteId)
  if (!data) notFound()
  const { worksite, reserves, reports, openCount, truncated } = data
  const tooMany = openCount > MAX_REPORT_RESERVES
  const hidden = <input type="hidden" name="worksiteId" value={worksite.id} />
  const today = formatDay(parisToday(serverNow()))

  return (
    <ReserveFormsProvider>
    <div className="space-y-4">
      <div>
        <Link href="/reserves" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:underline"><ArrowLeft className="h-4 w-4" /> Réserves et réception</Link>
        <h1 className="mt-1 flex items-center gap-2 text-2xl font-bold text-slate-900"><ClipboardCheck className="h-6 w-6 text-[#0f3460]" /> {worksite.name}</h1>
        <p className="mt-1 text-sm text-slate-500">{worksite.client.name}{worksite.address ? ` · ${worksite.address}` : ""}{worksite.archivedAt ? " · chantier archivé" : ""} · {openCount} réserve{openCount > 1 ? "s" : ""} ouverte{openCount > 1 ? "s" : ""} · {reports.length} procès-verbal{reports.length > 1 ? "aux" : ""}</p>
      </div>
      <ReserveFlash />

      <Card><CardContent className="space-y-3 p-4">
        <h2 className="text-sm font-semibold text-slate-900">Nouvelle réserve</h2>
        <ReserveForm kind="create" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{hidden}
          <Input name="title" required minLength={3} maxLength={200} placeholder="Intitulé (ex. éclat d'enduit)" aria-label="Intitulé" />
          <Input name="location" required maxLength={200} placeholder="Localisation (ex. R+1, chambre 2, mur nord)" aria-label="Localisation" />
          <select name="severity" defaultValue="MINOR" className={SELECT_CLASS} aria-label="Gravité">{SEVERITIES.map((s) => <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>)}</select>
          <Input name="assigneeLabel" maxLength={120} placeholder="Responsable de la levée (facultatif, texte libre)" aria-label="Responsable de la levée (texte libre)" />
          <Input name="dueDate" type="date" aria-label="Échéance de levée" />
          <Input name="files" type="file" multiple accept={FILE_ACCEPT} aria-label="Preuves (photos ou PDF, 5 Mo au plus chacune)" />
          <Input name="description" maxLength={4000} placeholder="Description (facultatif)" aria-label="Description" className="sm:col-span-2 lg:col-span-3" />
          <div className="sm:col-span-2 lg:col-span-3"><Button type="submit">Enregistrer la réserve</Button><span className="ml-2 text-xs text-slate-500">Preuves : photo JPEG, PNG ou WebP, ou PDF ; 5 fichiers et 5 Mo par fichier au plus.</span></div>
        </ReserveForm>
      </CardContent></Card>

      <Card><CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <caption className="sr-only">Réserves du chantier</caption>
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th scope="col" className="px-3 py-2">Réserve</th><th scope="col" className="hidden px-3 py-2 md:table-cell">Preuves</th><th scope="col" className="px-3 py-2">État</th><th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {reserves.length === 0 && <tr><td colSpan={4} className="px-3 py-8 text-center text-slate-400">Aucune réserve sur ce chantier.</td></tr>}
            {reserves.map((r) => (
              <tr key={r.id} className="border-t align-top">
                <td className="px-3 py-2">
                  <p className="font-medium">{r.number} · {r.title} <span className={`ml-1 rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_CLASS[r.severity] ?? ""}`}>{SEVERITY_LABEL[r.severity]}</span></p>
                  <p className="text-xs text-slate-500">{r.location}{r.assigneeLabel ? ` · responsable : ${r.assigneeLabel}` : ""}{r.dueDate ? ` · échéance ${fmtDay(r.dueDate)}` : ""} · constatée le {fmtInstant(r.createdAt)}{r._count.reports > 0 ? ` · inscrite à ${r._count.reports} procès-verbal(aux)` : ""}</p>
                  {r.description && <p className="mt-1 text-xs text-slate-600">{r.description}</p>}
                  {r.liftedAt && <p className="mt-1 text-xs text-green-700">Levée le {fmtInstant(r.liftedAt)} : {r.liftNote}</p>}
                  {r.cancelledAt && <p className="mt-1 text-xs text-slate-500">Annulée le {fmtInstant(r.cancelledAt)} : {r.cancelReason}</p>}
                </td>
                <td className="hidden px-3 py-2 md:table-cell">
                  {r.files.length === 0 ? <span className="text-xs text-slate-400">—</span> : r.files.map((f) => (
                    <a key={f.id} href={`/reserves/fichiers/${f.id}`} className="flex items-center gap-1 text-xs text-[#0f3460] hover:underline"><Paperclip className="h-3 w-3" />{f.kind === "LIFT" ? "Levée" : "Constat"} · {f.originalName} ({kb(f.size)})</a>
                  ))}
                </td>
                <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${RESERVE_STATUS_CLASS[r.status] ?? ""}`}>{STATUS_LABEL[r.status]}</span></td>
                <td className="px-3 py-2">
                  {r.status === "OPEN" && (
                    <div className="grid gap-2">
                      <ReserveForm kind="lift" className="grid gap-1">{hidden}<input type="hidden" name="reserveId" value={r.id} />
                        <Input name="note" required minLength={3} maxLength={2000} placeholder="Note de levée" aria-label={`Note de levée ${r.number}`} />
                        <Input name="files" type="file" multiple accept={FILE_ACCEPT} aria-label={`Preuves de levée ${r.number}`} />
                        <Button type="submit" size="sm">Lever</Button>
                      </ReserveForm>
                      {r._count.reports === 0 && (
                        <ReserveForm kind="cancel" className="flex gap-1">{hidden}<input type="hidden" name="reserveId" value={r.id} />
                          <Input name="reason" required minLength={3} maxLength={500} placeholder="Motif d'annulation" aria-label={`Motif d'annulation ${r.number}`} />
                          <Button type="submit" variant="outline" size="sm">Annuler</Button>
                        </ReserveForm>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent></Card>
      {truncated && <p role="status" className="text-xs text-slate-500">Affichage limité aux {MAX_LISTED_RESERVES} premières réserves du chantier : liste partielle. Le procès-verbal, lui, inscrit toutes les réserves ouvertes.</p>}

      <Card><CardContent className="space-y-3 p-4">
        <h2 className="text-sm font-semibold text-slate-900">Procès-verbaux de réception</h2>
        {reports.length === 0 ? <p className="text-xs text-slate-500">Aucun procès-verbal.</p> : (
          <ul className="space-y-2">
            {reports.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
                <span><span className="font-medium">{p.number}</span> · réception du {fmtDay(p.receptionDate)} · signé par {p.clientSignerName} le {fmtInstant(p.createdAt)} · {p._count.reserves} réserve(s) <span className={`ml-1 rounded-full px-2 py-0.5 text-xs font-medium ${DECISION_CLASS[p.decision] ?? ""}`}>{DECISION_LABEL[p.decision]}</span></span>
                <Button variant="outline" size="sm" asChild><a href={`/reserves/pv/${p.id}/pdf`}><FileDown className="h-4 w-4" /> PDF</a></Button>
              </li>
            ))}
          </ul>
        )}
        <ReserveForm kind="report" className="grid gap-2 border-t pt-3 sm:grid-cols-2">{hidden}
          <p className="text-xs text-slate-500 sm:col-span-2">Le procès-verbal inscrit automatiquement les {openCount} réserve(s) ouverte(s). Une fois signé, il est figé : il ne se modifie ni ne se supprime, et son PDF est régénéré depuis l&apos;instantané signé. La signature est un tracé manuscrit conservé avec son empreinte : ce n&apos;est pas une signature électronique qualifiée.</p>
          {tooMany && <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 sm:col-span-2">Plus de {MAX_REPORT_RESERVES} réserves ouvertes : un procès-verbal en inscrit {MAX_REPORT_RESERVES} au plus. Levez ou annulez des réserves avant de signer ; la signature sera refusée, jamais tronquée.</p>}
          {/* Retour d'état (même document) : la valeur par défaut d'un <select> non contrôlé ne suit pas un nouveau rendu ; la clé
              le remonte quand l'existence de réserves ouvertes change, pour que le défaut et form.reset() restent exacts. */}
          <select key={openCount > 0 ? "decision-avec-reserves" : "decision-sans-reserves"} name="decision" required defaultValue={openCount > 0 ? "WITH_RESERVES" : "WITHOUT_RESERVES"} className={SELECT_CLASS} aria-label="Décision">{DECISIONS.map((d) => <option key={d} value={d}>{DECISION_LABEL[d]}</option>)}</select>
          <Input name="receptionDate" type="date" required max={today} defaultValue={today} aria-label="Date de réception" />
          <Input name="clientSignerName" required minLength={2} maxLength={120} placeholder="Nom du signataire du maître d'ouvrage" aria-label="Signataire du maître d'ouvrage" />
          <Input name="companySignerName" required minLength={2} maxLength={120} placeholder="Nom du représentant de l'entreprise" aria-label="Représentant de l'entreprise" />
          <Input name="attendees" maxLength={1000} placeholder="Présents (facultatif)" aria-label="Présents" className="sm:col-span-2" />
          <Input name="remarks" maxLength={4000} placeholder="Observations (facultatif)" aria-label="Observations" className="sm:col-span-2" />
          <div className="sm:col-span-2"><ReportSignatureField label="Signature du maître d'ouvrage" /></div>
          <div className="sm:col-span-2"><Button type="submit">Signer et figer le procès-verbal</Button></div>
        </ReserveForm>
      </CardContent></Card>
    </div>
    </ReserveFormsProvider>
  )
}
