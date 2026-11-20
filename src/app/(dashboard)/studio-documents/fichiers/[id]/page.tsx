// Document Studio — espace PDF (lots 1 et 2) : fiche d'un PDF importé. Visionneuse (pages, vignettes, zoom), recherche
// dans le texte des pages (côté serveur, lien vers la page trouvée), versions successives (original puis versions
// remplies ou signées, chacune téléchargeable) et « Remplir et signer » sur la dernière version. Drapeau
// DOCUMENT_STUDIO_ENABLED + ADMIN/SUPER_ADMIN ; PDF d'une autre entreprise ⇒ 404. Aucun octet du fichier dans les
// propriétés de la page : la visionneuse lit la route protégée de la révision.
import { notFound } from "next/navigation"
import { FileText, Search } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { studioPageAccess } from "@/lib/document-studio/access"
import { AdminOnlyNotice } from "@/components/stock/AdminOnlyNotice"
import { getStudioPdfView } from "@/lib/document-studio/pdf-workspace.queries"
import { PDF_ERRORS, displaySize, searchPages } from "@/lib/document-studio/pdf-workspace.core"
import { Card, CardContent } from "@/components/ui/card"
import { StockFlash } from "@/components/stock/StockFlash"
import { MessageRetour, ZoneRetour } from "@/components/crm/RetourFormulaire"
import { fmtInstant } from "@/components/equipment/labels"
import { StudioPdfWorkspace } from "@/components/document-studio/StudioPdfWorkspace"

const ID = /^[A-Za-z0-9_-]{1,64}$/
const LIEN = "text-[#0f3460] underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f3460] rounded-sm"
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "")
const sizeFr = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} Ko` : `${(n / (1024 * 1024)).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Mo`)

export default async function StudioPdfPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await studioPageAccess()
  if (!ctx) return <AdminOnlyNotice />
  const { id } = await params
  const sp = await searchParams
  if (!ID.test(id)) notFound()
  const rRaw = one(sp.r)
  const revisionNumber = /^\d{1,3}$/.test(rRaw) ? Number(rRaw) : null
  const v = await getStudioPdfView(prisma, ctx.companyId, id, revisionNumber)
  if (!v) notFound()
  const q = one(sp.q).slice(0, 100)
  const hits = searchPages(v.pageTexts, q)
  const isLatest = v.shown.id === v.latest.id
  const base = `/studio-documents/fichiers/${v.id}`
  const fileUrl = (revId: string) => `${base}/revisions/${revId}`
  const blocked = !isLatest ? "Remplir et signer se fait sur la dernière version : ouvrez-la depuis la liste des versions." : v.shown.encrypted ? PDF_ERRORS.encrypted : null
  const hasText = v.pageTexts.some((t) => t.length > 0)

  return (
    <ZoneRetour rendu={Date.now()}>
    <div className="space-y-4">
      <div>
        <a href="/studio-documents#fichiers" className={`text-xs ${LIEN}`}>← PDF importés</a>
        <h1 className="mt-1 flex items-center gap-2 text-2xl font-bold text-slate-900"><FileText aria-hidden="true" className="h-6 w-6 shrink-0 text-[#0f3460]" /><span className="min-w-0 break-words">{v.title}</span></h1>
        <p className="text-sm text-slate-600">
          {v.originalName} · importé le {fmtInstant(v.createdAt)} · {v.shown.pageCount} page{v.shown.pageCount > 1 ? "s" : ""} ·{" "}
          version {v.shown.revision}{isLatest ? "" : ` (la plus récente est la ${v.latest.revision})`}
        </p>
      </div>
      <MessageRetour><StockFlash params={sp} /></MessageRetour>

      <form method="get" action={base} role="search" className="flex max-w-xl items-center gap-2">
        {!isLatest && <input type="hidden" name="r" value={v.shown.revision} />}
        <label htmlFor="recherche-pdf" className="sr-only">Rechercher dans le document</label>
        <div className="relative flex-1">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input id="recherche-pdf" name="q" type="search" defaultValue={q} maxLength={100} placeholder={hasText ? "Rechercher dans le document" : "Document sans texte (scan) : recherche indisponible"} disabled={!hasText}
            className="h-10 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-sm text-slate-800 placeholder:text-slate-500 focus-visible:border-[#0f3460] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f3460]/30 disabled:bg-slate-50" />
        </div>
        <button type="submit" disabled={!hasText} className="h-10 rounded-lg bg-[#0f3460] px-3 text-sm font-medium text-white hover:bg-[#0c2a4d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f3460] focus-visible:ring-offset-2 disabled:opacity-50">Rechercher</button>
      </form>
      {q.trim().length >= 2 && (
        <section aria-labelledby="resultats-titre" className="rounded-xl border border-slate-200 bg-white p-3">
          <h2 id="resultats-titre" className="text-sm font-semibold text-slate-900">
            {hits.length === 0 ? `Aucun résultat pour « ${q.trim()} »` : `« ${q.trim()} » : ${hits.reduce((s, h) => s + h.count, 0)} occurrence(s) sur ${hits.length} page(s)`}
          </h2>
          {hits.length > 0 && (
            <ul className="mt-2 divide-y divide-slate-100 text-sm">
              {hits.map((h) => (
                <li key={h.page} className="py-1.5">
                  <a href={`#page-${h.page}`} className={`font-medium ${LIEN}`}>Page {h.page}</a>
                  <span className="ml-2 text-xs text-slate-500">{h.count} fois</span>
                  <p className="text-xs text-slate-600">{h.snippet}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <StudioPdfWorkspace
        key={v.shown.id}
        pdfId={v.id}
        title={v.title}
        revisionId={v.shown.id}
        revisionNumber={v.shown.revision}
        fileUrl={fileUrl(v.shown.id)}
        downloadUrl={`${fileUrl(v.shown.id)}?telecharger=1`}
        pages={v.pages.map(displaySize)}
        editable={blocked === null}
        editBlockedReason={blocked}
      />

      <Card><CardContent className="p-4">
        <h2 className="text-sm font-semibold text-slate-900">Versions</h2>
        <p className="mt-0.5 text-xs text-slate-600">Chaque enregistrement crée une nouvelle version ; l&apos;original n&apos;est jamais modifié.</p>
        <ol className="mt-2 divide-y divide-slate-200 text-sm">
          {v.revisions.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0">
                <span className="font-medium text-slate-800">Version {r.revision}</span>{" "}
                <span className="text-xs text-slate-600">
                  · {r.kind === "ORIGINAL" ? "original importé" : r.signerName ? `remplie et signée par ${r.signerName}` : "remplie"} · {fmtInstant(r.createdAt)} · {sizeFr(r.size)} · empreinte {r.sha256.slice(0, 12)}
                </span>
                {r.id === v.shown.id && <span className="ml-2 rounded-full bg-[#0f3460]/10 px-2 py-0.5 text-xs font-medium text-[#0f3460]">affichée</span>}
              </span>
              <span className="flex items-center gap-3 text-sm">
                {r.id !== v.shown.id && <a href={r.id === v.latest.id ? base : `${base}?r=${r.revision}`} className={LIEN}>Afficher</a>}
                <a href={`${fileUrl(r.id)}?telecharger=1`} className={LIEN}>Télécharger</a>
              </span>
            </li>
          ))}
        </ol>
      </CardContent></Card>
    </div>
    </ZoneRetour>
  )
}
