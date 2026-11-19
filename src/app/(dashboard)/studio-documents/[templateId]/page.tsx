// Lot G Planificator V2 : un modèle du Document Studio — versions, brouillon modifiable, publication (figée), et
// génération d'un document depuis la version publiée. Drapeau DOCUMENT_STUDIO_ENABLED + ADMIN/SUPER_ADMIN.
// Portage sur ef36578f : refus rendu sur place avant toute lecture (AdminOnlyNotice), retour explicite E4 (ZoneRetour,
// MessageRetour, FormulaireRetour), lien HTML natif vers la liste (navigation du document).
import { notFound } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { studioPageAccess } from "@/lib/document-studio/access"
import { AdminOnlyNotice } from "@/components/stock/AdminOnlyNotice"
import { CATEGORY_LABEL, FIELD_TYPE_LABEL, fieldLines, readFields, type Category } from "@/lib/document-studio/studio.core"
import { getTemplate } from "@/lib/document-studio/queries"
import { createDraftAction, generateDocumentAction, publishVersionAction, updateDraftAction } from "@/lib/actions/document-studio.actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { SELECT_CLASS, StockFlash } from "@/components/stock/StockFlash"
import { FormulaireRetour, MessageRetour, ZoneRetour } from "@/components/crm/RetourFormulaire"
import { fmtInstant } from "@/components/equipment/labels"
import { FIELDS_HELP, VERSION_STATUS_LABEL } from "@/components/document-studio/labels"

const ID = /^[A-Za-z0-9_-]{1,64}$/

export default async function TemplatePage({ params, searchParams }: { params: Promise<{ templateId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await studioPageAccess()
  // Rôle ou société non habilités : refus rendu sur place, avant toute lecture métier (modèle des lots A et B).
  if (!ctx) return <AdminOnlyNotice />
  const { templateId } = await params
  const sp = await searchParams
  if (!ID.test(templateId)) notFound()
  const t = await getTemplate(prisma, ctx.companyId, templateId)
  if (!t) notFound()
  const draft = t.versions.find((v) => v.status === "DRAFT")
  const published = t.versions.find((v) => v.status === "PUBLISHED")
  const publishedFields = published ? readFields(published.fields) ?? [] : []
  const clients = published ? await prisma.client.findMany({ where: { companyId: ctx.companyId }, orderBy: [{ name: "asc" }, { id: "asc" }], take: 500, select: { id: true, name: true } }) : []
  const worksites = published ? await prisma.worksite.findMany({ where: { companyId: ctx.companyId }, orderBy: [{ name: "asc" }, { id: "asc" }], take: 500, select: { id: true, name: true } }) : []

  return (
    <ZoneRetour rendu={Date.now()}>
    <div className="space-y-4">
      <div>
        <a href="/studio-documents" className="text-xs text-[#0f3460] underline">← Document Studio</a>
        <h1 className="text-2xl font-bold text-slate-900">{t.name}</h1>
        <p className="text-sm text-slate-500">{CATEGORY_LABEL[t.category as Category] ?? t.category}</p>
      </div>
      <MessageRetour><StockFlash params={sp} /></MessageRetour>

      <Card><CardContent className="p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-900">Versions</h2>
        <ul className="space-y-1 text-sm">
          {t.versions.map((v) => (
            <li key={v.id}>v{v.version} · {VERSION_STATUS_LABEL[v.status] ?? v.status}{v.publishedAt ? ` le ${fmtInstant(v.publishedAt)}` : ""}{v.contentSha256 ? ` · empreinte ${v.contentSha256.slice(0, 12)}` : ""}{v.requiresApproval ? " · validation requise" : ""}</li>
          ))}
        </ul>
        {!draft && (
          <FormulaireRetour action={createDraftAction} className="mt-3"><input type="hidden" name="templateId" value={t.id} /><Button type="submit" size="sm" variant="outline">Nouveau brouillon depuis la dernière version</Button></FormulaireRetour>
        )}
      </CardContent></Card>

      {draft && (
        <Card><CardContent className="space-y-3 p-4">
          <h2 className="text-sm font-semibold text-slate-900">Brouillon v{draft.version}</h2>
          <FormulaireRetour action={updateDraftAction} className="grid gap-2">
            <input type="hidden" name="templateId" value={t.id} /><input type="hidden" name="versionId" value={draft.id} />
            <Input name="title" required minLength={3} maxLength={200} defaultValue={draft.title} aria-label="Titre du document" />
            <textarea name="body" required maxLength={20000} rows={12} defaultValue={draft.body} aria-label="Corps du document" className="rounded-md border border-input bg-background p-2 text-sm" />
            <textarea name="fields" rows={5} defaultValue={fieldLines(readFields(draft.fields) ?? [])} aria-label="Champs déclarés" className="rounded-md border border-input bg-background p-2 font-mono text-xs" />
            <p className="text-xs text-slate-500">{FIELDS_HELP}</p>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="requiresApproval" value="oui" defaultChecked={draft.requiresApproval} /> Validation par un second administrateur avant émission</label>
            <div><Button type="submit" variant="outline">Enregistrer le brouillon</Button></div>
          </FormulaireRetour>
          <FormulaireRetour action={publishVersionAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="templateId" value={t.id} /><input type="hidden" name="versionId" value={draft.id} />
            <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="confirm" value="oui" required /> Publier : cette version sera figée et remplacera la version publiée</label>
            <Button type="submit" size="sm">Publier v{draft.version}</Button>
          </FormulaireRetour>
        </CardContent></Card>
      )}

      {published && (
        <Card><CardContent className="space-y-3 p-4">
          <h2 id="generer" className="scroll-mt-4 text-sm font-semibold text-slate-900">Générer un document (v{published.version} publiée)</h2>
          <FormulaireRetour action={generateDocumentAction} className="grid gap-2 sm:grid-cols-2">
            <input type="hidden" name="templateId" value={t.id} />
            <select name="clientId" defaultValue="" className={SELECT_CLASS} aria-label="Client"><option value="">Sans client</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            <select name="worksiteId" defaultValue="" className={SELECT_CLASS} aria-label="Chantier"><option value="">Sans chantier</option>{worksites.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
            {publishedFields.map((f) => (
              <label key={f.key} className={`grid gap-1 text-sm ${f.type === "LONG_TEXT" ? "sm:col-span-2" : ""}`}>
                <span>{f.label}{f.required ? " *" : ""} <span className="text-xs text-slate-500">({FIELD_TYPE_LABEL[f.type]})</span></span>
                {f.type === "LONG_TEXT"
                  ? <textarea name={`f_${f.key}`} required={f.required} maxLength={4000} rows={4} className="rounded-md border border-input bg-background p-2 text-sm" />
                  : <Input name={`f_${f.key}`} required={f.required} type={f.type === "DATE" ? "date" : "text"} inputMode={f.type === "AMOUNT" || f.type === "NUMBER" ? "decimal" : undefined} maxLength={500} />}
              </label>
            ))}
            <div className="sm:col-span-2"><Button type="submit">Générer</Button></div>
          </FormulaireRetour>
        </CardContent></Card>
      )}
    </div>
    </ZoneRetour>
  )
}
