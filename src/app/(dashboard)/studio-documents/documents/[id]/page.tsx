// Lot G Planificator V2 : un document généré — contenu figé (instantané), validation signée par un AUTRE
// administrateur que l'auteur, ou refus motivé ; PDF reconstruit depuis l'instantané. Drapeau DOCUMENT_STUDIO_ENABLED
// + ADMIN/SUPER_ADMIN.
// Portage sur ef36578f : refus rendu sur place avant toute lecture (AdminOnlyNotice), retour explicite E4 (ZoneRetour,
// MessageRetour, FormulaireRetour), liens HTML natifs (modèle, PDF), champ de signature local au lot G ; la lecture de
// l'écran n'inclut pas les octets de la signature (aucune image dans les propriétés de la page).
import { notFound } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { studioPageAccess } from "@/lib/document-studio/access"
import { AdminOnlyNotice } from "@/components/stock/AdminOnlyNotice"
import { getGeneratedDocumentView } from "@/lib/document-studio/queries"
import { approveDocumentAction, rejectDocumentAction } from "@/lib/actions/document-studio.actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { StockFlash } from "@/components/stock/StockFlash"
import { FormulaireRetour, MessageRetour, ZoneRetour } from "@/components/crm/RetourFormulaire"
import { fmtInstant } from "@/components/equipment/labels"
import { StudioSignatureField } from "@/components/document-studio/StudioSignatureField"
import { DOC_STATUS_CLASS, DOC_STATUS_LABEL } from "@/components/document-studio/labels"

const ID = /^[A-Za-z0-9_-]{1,64}$/

export default async function GeneratedDocumentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await studioPageAccess()
  // Rôle ou société non habilités : refus rendu sur place, avant toute lecture métier (modèle des lots A et B).
  if (!ctx) return <AdminOnlyNotice />
  const { id } = await params
  const sp = await searchParams
  if (!ID.test(id)) notFound()
  const d = await getGeneratedDocumentView(prisma, ctx.companyId, id)
  if (!d) notFound()
  const own = d.createdById === ctx.userId

  return (
    <ZoneRetour rendu={Date.now()}>
    <div className="space-y-4">
      <div>
        <a href={`/studio-documents/${d.version.templateId}`} className="text-xs text-[#0f3460] underline">← Modèle</a>
        <h1 className="text-2xl font-bold text-slate-900">{d.snapshot?.title ?? d.number}</h1>
        <p className="text-sm text-slate-500">{d.number} · créé le {fmtInstant(d.createdAt)} · <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${DOC_STATUS_CLASS[d.status] ?? ""}`}>{DOC_STATUS_LABEL[d.status] ?? d.status}</span></p>
      </div>
      <MessageRetour><StockFlash params={sp} /></MessageRetour>
      {!d.intact && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">Empreinte du contenu non conforme : le PDF est bloqué.</p>}
      {d.intact && <a href={`/studio-documents/documents/${d.id}/pdf`} className="inline-block text-sm text-[#0f3460] underline">Télécharger le PDF</a>}

      {d.snapshot && (
        <Card><CardContent className="space-y-2 p-4 text-sm">
          {d.snapshot.blocks.map((b, i) => b.kind === "heading" ? <h2 key={i} className="pt-2 font-semibold text-[#0f3460]">{b.text}</h2> : <p key={i} className="whitespace-pre-line">{b.text}</p>)}
          <p className="pt-2 text-xs text-slate-500">Modèle « {d.snapshot.template.name} » v{d.snapshot.template.version} · empreinte {d.snapshotSha256.slice(0, 16)}</p>
        </CardContent></Card>
      )}

      {d.status === "ISSUED" && d.signerName && <p className="text-sm text-slate-600">Validé par {d.signerName}{d.approvedAt ? ` le ${fmtInstant(d.approvedAt)}` : ""}.</p>}
      {d.status === "REJECTED" && <p className="text-sm text-red-700">Refusé{d.rejectedAt ? ` le ${fmtInstant(d.rejectedAt)}` : ""} : {d.rejectReason}</p>}

      {d.status === "PENDING_APPROVAL" && (own ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">Vous êtes l&apos;auteur de ce document : sa validation revient à un autre administrateur.</p>
      ) : (
        <Card><CardContent className="space-y-4 p-4">
          <FormulaireRetour action={approveDocumentAction} className="grid gap-2">
            <input type="hidden" name="documentId" value={d.id} />
            <Input name="signerName" required minLength={2} maxLength={120} placeholder="Nom du signataire" aria-label="Nom du signataire" />
            <StudioSignatureField label="Signature du valideur" />
            <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="confirm" value="oui" required /> Je valide ce document</label>
            <div><Button type="submit">Valider et signer</Button></div>
          </FormulaireRetour>
          <FormulaireRetour action={rejectDocumentAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="documentId" value={d.id} />
            <Input name="reason" required minLength={3} maxLength={500} placeholder="Motif du refus" aria-label="Motif du refus" className="max-w-md" />
            <Button type="submit" variant="outline">Refuser</Button>
          </FormulaireRetour>
        </CardContent></Card>
      ))}
    </div>
    </ZoneRetour>
  )
}
