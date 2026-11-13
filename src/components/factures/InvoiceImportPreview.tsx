"use client"
// Aperçu modifiable d'un import de factures (SPEC-INVOICE-IMPORT-001). Aucune règle métier ici : les anomalies, doublons et
// conflits viennent de l'analyse serveur ; ce composant édite les lignes, enregistre les corrections puis demande la validation.
import { useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { AlertTriangle, CheckCircle2, FileText, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { cancelInvoiceImportAction, commitInvoiceImportAction, updateInvoiceImportMappingAction, updateInvoiceImportRowsAction } from "@/lib/actions/invoice-import.actions"
import { KIND_LABEL, STATUS_LABEL, centsToEuros, eurosToCents } from "@/lib/invoice-import/format"
import { IMPORT_FIELDS, IMPORT_FIELD_LABEL, type AnalyzedRow, type BatchSummary, type ColumnMapping, type ImportField, type ImportRowKind, type ImportStatus, type PreviewRow } from "@/lib/invoice-import/types"

interface Option { id: string; name: string }
interface Props {
  batchId: string; version: number; analyzed: AnalyzedRow[]; summary: BatchSummary
  table: { file: string; headers: string[]; sample: (string | number | null)[][]; mapping: ColumnMapping } | null
  clients: Option[]; worksites: (Option & { clientId: string })[]
}
type Draft = Pick<PreviewRow, "kind" | "number" | "clientName" | "clientId" | "createClient" | "worksiteId" | "issueDate" | "dueDate" | "status" | "creditedNumber" | "decision" | "excluded"> & { ht: string; vat: string; ttc: string }

const toDraft = (r: PreviewRow, resolvedClientId: string | null): Draft => ({
  kind: r.kind, number: r.number, clientName: r.clientName, clientId: r.clientId ?? resolvedClientId, createClient: r.createClient, worksiteId: r.worksiteId, issueDate: r.issueDate, dueDate: r.dueDate,
  status: r.status, creditedNumber: r.creditedNumber, decision: r.decision, excluded: r.excluded, ht: centsToEuros(r.htCents), vat: centsToEuros(r.vatCents), ttc: centsToEuros(r.ttcCents),
})
const cell = "h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
const OUTCOME: Record<AnalyzedRow["outcome"], { label: string; className: string }> = {
  IMPORT: { label: "À importer", className: "bg-green-50 text-green-700" }, ATTACH: { label: "PDF à ajouter", className: "bg-green-50 text-green-700" },
  SKIP: { label: "Ignorée", className: "bg-slate-100 text-slate-600" }, BLOCKED: { label: "À corriger", className: "bg-red-50 text-red-700" },
  REDIRECT: { label: "Fournisseur", className: "bg-amber-50 text-amber-700" },
}

export function InvoiceImportPreview({ batchId, version, analyzed, summary, table, clients, worksites }: Props) {
  const router = useRouter()
  const initial = useMemo(() => new Map(analyzed.map((a) => [a.row.id, toDraft(a.row, a.resolvedClientId)])), [analyzed])
  const [drafts, setDrafts] = useState(initial)
  const [dirty, setDirty] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [mapping, setMapping] = useState<ColumnMapping | null>(table?.mapping ?? null)
  const [confirming, setConfirming] = useState(false)

  const edit = (id: string, patch: Partial<Draft>) => {
    setDrafts((prev) => { const next = new Map(prev); next.set(id, { ...(prev.get(id) as Draft), ...patch }); return next })
    setDirty((prev) => new Set(prev).add(id))
    setConfirming(false)
  }

  async function save(): Promise<boolean> {
    const patches = []
    for (const id of dirty) {
      const d = drafts.get(id) as Draft
      const ht = eurosToCents(d.ht), vat = eurosToCents(d.vat), ttc = eurosToCents(d.ttc)
      if (ht === undefined || vat === undefined || ttc === undefined) { toast.error(`Montant illisible sur la pièce ${d.number || "sans numéro"}.`); return false }
      patches.push({ id, kind: d.kind, number: d.number, clientName: d.clientName, clientId: d.clientId, createClient: d.createClient, worksiteId: d.worksiteId, issueDate: d.issueDate || null, dueDate: d.dueDate || null, htCents: ht, vatCents: vat, ttcCents: ttc, status: d.status, creditedNumber: d.creditedNumber?.trim() || null, decision: d.decision, excluded: d.excluded })
    }
    if (patches.length === 0) return true
    setBusy(true)
    try {
      const r = await updateInvoiceImportRowsAction(batchId, version, patches)
      if (!r.ok) { toast.error(r.error); return false }
      toast.success("Corrections enregistrées.")
      router.refresh()
      return true
    } finally { setBusy(false) }
  }

  async function commit() {
    setBusy(true)
    try {
      const r = await commitInvoiceImportAction(batchId, version)
      if (!r.ok) { toast.error(r.error); router.refresh(); return }
      toast.success(`${r.summary.toImport} pièce(s) importée(s).`)
      router.push("/factures/importees")
    } finally { setBusy(false); setConfirming(false) }
  }

  async function cancel() {
    if (!window.confirm("Annuler cet import ? Les fichiers déposés pour cet aperçu seront supprimés.")) return
    setBusy(true)
    try { const r = await cancelInvoiceImportAction(batchId); if (!r.ok) toast.error(r.error); else router.push("/factures/import") } finally { setBusy(false) }
  }

  async function applyMapping() {
    if (!mapping) return
    if (!window.confirm("Appliquer cette association ? Les corrections déjà faites sur les lignes issues de l’export seront recalculées.")) return
    setBusy(true)
    try { const r = await updateInvoiceImportMappingAction(batchId, version, mapping); if (!r.ok) toast.error(r.error); else { toast.success("Colonnes associées."); router.refresh() } } finally { setBusy(false) }
  }

  const isDirty = dirty.size > 0
  const canCommit = !isDirty && summary.blocked === 0 && summary.toImport + summary.toAttach > 0

  return (
    <div className="space-y-4">
      {table && mapping && (
        <Card><CardContent className="space-y-3 p-4">
          <h2 className="text-sm font-semibold text-slate-700">Correspondance des colonnes — {table.file}</h2>
          <p className="text-xs text-slate-500">Association proposée d’après les en-têtes ; corrigez-la si besoin. Elle sera reproposée pour le prochain export identique du même logiciel.</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {IMPORT_FIELDS.map((f: ImportField) => (
              <label key={f} className="flex flex-col gap-1 text-xs">{IMPORT_FIELD_LABEL[f]}{f === "number" ? " *" : ""}
                <select className={cell} value={mapping[f] ?? ""} onChange={(e) => setMapping({ ...mapping, [f]: e.target.value === "" ? undefined : Number(e.target.value) })}>
                  <option value="">— non associé —</option>
                  {table.headers.map((h, i) => <option key={i} value={i}>{h}{table.sample[0]?.[i] != null ? ` (ex. ${String(table.sample[0][i]).slice(0, 24)})` : ""}</option>)}
                </select>
              </label>
            ))}
            <label className="flex flex-col gap-1 text-xs">Lignes d’en-tête à ignorer<input type="number" min={0} max={20} className={cell} value={mapping.headerRows} onChange={(e) => setMapping({ ...mapping, headerRows: Math.max(0, Math.min(20, Number(e.target.value) || 0)) })} /></label>
          </div>
          <Button type="button" variant="secondary" onClick={applyMapping} disabled={busy}>Appliquer l’association</Button>
        </CardContent></Card>
      )}

      <Card><CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 p-4 text-sm" aria-live="polite">
        <span><strong>{summary.toImport}</strong> à importer</span>
        {summary.toAttach > 0 && <span><strong>{summary.toAttach}</strong> PDF à ajouter</span>}
        <span className={summary.blocked > 0 ? "text-red-700" : ""}><strong>{summary.blocked}</strong> à corriger</span>
        <span><strong>{summary.skipped}</strong> ignorée(s)</span>
        {summary.supplier > 0 && <span className="text-amber-700"><strong>{summary.supplier}</strong> facture(s) fournisseur (non importées ici)</span>}
      </CardContent></Card>

      {analyzed.length === 0 ? <Card><CardContent className="p-8 text-center text-sm text-slate-400">Aucune ligne pour le moment. Associez les colonnes ou ajoutez des fichiers.</CardContent></Card> : (
        <div className="space-y-3">
          {analyzed.map((a) => {
            const d = drafts.get(a.row.id) as Draft
            const o = OUTCOME[a.outcome]
            const clientWorksites = d.clientId ? worksites.filter((w) => w.clientId === d.clientId) : worksites
            return (
              <Card key={a.row.id} className={d.excluded ? "opacity-60" : ""}><CardContent className="space-y-3 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                  <span className="flex items-center gap-2"><span className={`rounded-full px-2 py-0.5 font-medium ${o.className}`}>{o.label}</span>{a.row.origin.file}{a.row.origin.line ? ` · ligne ${a.row.origin.line}` : ""}</span>
                  <span className="flex items-center gap-3">
                    {a.row.fileId ? <a className="inline-flex items-center gap-1 underline" href={`/factures/import/${batchId}/fichier/${a.row.fileId}`} target="_blank" rel="noopener noreferrer"><FileText className="h-3.5 w-3.5" />{a.row.fileName ?? "PDF"}</a> : <span>Sans PDF</span>}
                    <label className="flex items-center gap-1"><input type="checkbox" checked={d.excluded} onChange={(e) => edit(a.row.id, { excluded: e.target.checked })} /> Exclure</label>
                  </span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
                  <label className="flex flex-col gap-1 text-xs">Type de pièce<select className={cell} value={d.kind} onChange={(e) => edit(a.row.id, { kind: e.target.value as ImportRowKind })}>{(Object.keys(KIND_LABEL) as ImportRowKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></label>
                  <label className="flex flex-col gap-1 text-xs">Numéro<input className={cell} value={d.number} maxLength={64} onChange={(e) => edit(a.row.id, { number: e.target.value })} /></label>
                  <label className="flex flex-col gap-1 text-xs">Date<input type="date" className={cell} value={d.issueDate ?? ""} onChange={(e) => edit(a.row.id, { issueDate: e.target.value || null })} /></label>
                  <label className="flex flex-col gap-1 text-xs">Échéance<input type="date" className={cell} value={d.dueDate ?? ""} onChange={(e) => edit(a.row.id, { dueDate: e.target.value || null })} /></label>
                  <label className="flex flex-col gap-1 text-xs">Statut{a.row.sourceStatus ? ` (source : ${a.row.sourceStatus})` : ""}<select className={cell} value={d.status} onChange={(e) => edit(a.row.id, { status: e.target.value as ImportStatus })}>{(Object.keys(STATUS_LABEL) as ImportStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select></label>
                  {d.kind === "CREDIT_NOTE" && <label className="flex flex-col gap-1 text-xs">Facture d’origine<input className={cell} value={d.creditedNumber ?? ""} maxLength={64} placeholder="N° de la facture" onChange={(e) => edit(a.row.id, { creditedNumber: e.target.value })} />{a.credited && <span className="text-green-700">Liée à {a.credited.number}</span>}</label>}
                </div>
                {d.kind !== "SUPPLIER" && (
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
                    <label className="flex flex-col gap-1 text-xs lg:col-span-2">Client{a.row.clientName ? ` (source : ${a.row.clientName})` : ""}
                      <select className={cell} value={d.createClient ? "__new" : d.clientId ?? ""} onChange={(e) => edit(a.row.id, e.target.value === "__new" ? { createClient: true, clientId: null } : { createClient: false, clientId: e.target.value || null })}>
                        <option value="">— à choisir —</option>
                        {a.clientCandidates.length > 0 && <optgroup label="Suggestions">{a.clientCandidates.map((c) => <option key={`s-${c.id}`} value={c.id}>{c.name}</option>)}</optgroup>}
                        <optgroup label="Tous les clients">{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>
                        {d.clientName.trim() && <option value="__new">Créer le client « {d.clientName.trim()} »</option>}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-xs">Chantier (facultatif)<select className={cell} value={d.worksiteId ?? ""} onChange={(e) => edit(a.row.id, { worksiteId: e.target.value || null })}><option value="">— aucun —</option>{clientWorksites.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
                    <label className="flex flex-col gap-1 text-xs">HT (€)<input inputMode="decimal" className={`${cell} text-right tabular-nums`} value={d.ht} onChange={(e) => edit(a.row.id, { ht: e.target.value })} /></label>
                    <label className="flex flex-col gap-1 text-xs">TVA (€)<input inputMode="decimal" className={`${cell} text-right tabular-nums`} value={d.vat} onChange={(e) => edit(a.row.id, { vat: e.target.value })} /></label>
                    <label className="flex flex-col gap-1 text-xs">TTC (€)<input inputMode="decimal" className={`${cell} text-right tabular-nums`} value={d.ttc} onChange={(e) => edit(a.row.id, { ttc: e.target.value })} /></label>
                  </div>
                )}
                {a.anomalies.length > 0 && (
                  <ul className="space-y-1 text-xs">
                    {a.anomalies.map((an, i) => <li key={i} className={`flex items-start gap-1 ${an.blocking ? "text-red-700" : "text-amber-700"}`}><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{an.message}{an.code === "SUPPLIER_DOCUMENT" && <Link className="ml-1 underline" href="/comptabilite/fournisseurs/nouvelle">Ouvrir le parcours fournisseur</Link>}</li>)}
                  </ul>
                )}
                {a.conflict && a.conflict.differences.length > 0 && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs">
                    <p className="font-medium text-amber-800">Différences avec la pièce déjà importée (elle ne sera pas modifiée) :</p>
                    <ul className="mt-1 space-y-0.5">{a.conflict.differences.map((x) => <li key={x.field}>{x.field} : existant « {x.existing} » · ce fichier « {x.incoming} »</li>)}</ul>
                    <label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={d.decision === "KEEP"} onChange={(e) => edit(a.row.id, { decision: e.target.checked ? "KEEP" : null })} /> Conserver l’existant et ignorer cette ligne</label>
                  </div>
                )}
              </CardContent></Card>
            )
          })}
        </div>
      )}

      <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t bg-white/95 py-3">
        <Button type="button" variant="secondary" onClick={save} disabled={busy || !isDirty}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer les corrections</Button>
        {!confirming ? <Button type="button" onClick={() => setConfirming(true)} disabled={busy || !canCommit}><CheckCircle2 className="h-4 w-4" /> Valider l’import</Button> : (
          <span className="flex flex-wrap items-center gap-2 text-sm">Importer {summary.toImport} pièce(s){summary.toAttach > 0 ? ` et ajouter ${summary.toAttach} PDF` : ""} ?
            <Button type="button" onClick={commit} disabled={busy}>Confirmer</Button><Button type="button" variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>Retour</Button></span>
        )}
        <Button type="button" variant="ghost" onClick={cancel} disabled={busy}>Annuler l’import</Button>
        {isDirty && <span className="text-xs text-slate-500">Enregistrez les corrections pour mettre à jour les contrôles.</span>}
        {!isDirty && summary.blocked > 0 && <span className="text-xs text-red-700">{summary.blocked} ligne(s) à corriger ou à exclure avant validation.</span>}
      </div>
    </div>
  )
}
