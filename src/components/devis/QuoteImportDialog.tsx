"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { importQuotesAction } from "@/lib/actions/quote.actions"
import type { ImportReport } from "@/lib/billing/quotes/quote.service"

export function QuoteImportDialog() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [report, setReport] = useState<ImportReport | null>(null)

  async function onFile(file: File | undefined) {
    if (!file) return
    if (file.size > 1_000_000) { toast.error("Fichier trop volumineux (1 Mo maximum)."); return }
    setLoading(true); setReport(null)
    try {
      const text = await file.text()
      const r = await importQuotesAction(text)
      if (!r.ok) { toast.error(r.error); return }
      setReport(r.report)
      if (r.report.fatal) toast.error(r.report.fatal)
      else { toast.success(`${r.report.imported.length} devis importé(s).`); router.refresh() }
    } catch { toast.error("Erreur serveur : import non effectué.") } finally { setLoading(false) }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button variant="outline"><Upload className="h-4 w-4" /> Importer depuis…</Button></DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Importer des devis (CSV)</DialogTitle></DialogHeader>
        <p className="text-sm text-slate-600">Fichier CSV avec en-tête. Colonnes obligatoires : <code>reference</code>, <code>chantier</code>, <code>designation</code>, <code>quantite</code>, <code>prix_unitaire_ht</code>, <code>tva</code>. Facultatives : <code>unite</code>, <code>remise</code>, <code>description</code>, <code>validite</code>, <code>notes</code>, <code>objet</code>, <code>remise_globale</code>. Une référence = un devis brouillon ; une référence déjà importée est ignorée.</p>
        <input type="file" accept=".csv,text/csv" disabled={loading} onChange={(e) => void onFile(e.target.files?.[0])} className="text-sm" />
        {loading && <p className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" /> Import en cours…</p>}
        {report && !report.fatal && (
          <div className="space-y-2 text-sm">
            <p><strong>{report.imported.length}</strong> importé(s) · <strong>{report.skipped.length}</strong> ignoré(s) · <strong>{report.invalid.length}</strong> invalide(s)</p>
            {report.imported.length > 0 && <ul className="list-disc pl-5 text-green-700">{report.imported.map((i) => <li key={i.reference}>{i.reference} → {i.number}</li>)}</ul>}
            {report.skipped.length > 0 && <ul className="list-disc pl-5 text-slate-500">{report.skipped.map((i) => <li key={i.reference}>{i.reference} : {i.reason}</li>)}</ul>}
            {report.invalid.length > 0 && <ul className="list-disc pl-5 text-red-600">{report.invalid.map((i, k) => <li key={k}>{i.reference} (lignes {i.rows.join(", ")}) : {i.errors.join(" ; ")}</li>)}</ul>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
