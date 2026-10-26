"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { importBankStatementAction, previewBankCsvAction } from "@/lib/actions/accounting-c5.actions"

type Mapping = { date: number; label: number; amount?: number; debit?: number; credit?: number; reference?: number; bankId?: number; headerRows: number }

function Sel({ k, label, optional, header, mapping, onChange }: { k: keyof Mapping; label: string; optional?: boolean; header: string[]; mapping: Mapping; onChange: (m: Mapping) => void }) {
  return (
    <label className="flex flex-col gap-1 text-xs">{label}<select value={mapping[k] !== undefined ? String(mapping[k]) : ""} onChange={(e) => onChange({ ...mapping, [k]: e.target.value === "" ? undefined : Number(e.target.value) })} className="h-8 rounded-md border border-input bg-background px-2 text-xs">{optional && <option value="">—</option>}{header.map((h, i) => <option key={i} value={i}>{h || `colonne ${i + 1}`}</option>)}</select></label>
  )
}

export function BankImportDialog() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [text, setText] = useState(""); const [fileName, setFileName] = useState("")
  const [header, setHeader] = useState<string[]>([]); const [sample, setSample] = useState<string[][]>([])
  const [mapping, setMapping] = useState<Mapping | null>(null)
  const [mode, setMode] = useState<"amount" | "debitcredit">("amount")

  async function onFile(file: File | undefined) {
    if (!file) return
    if (file.size > 2_000_000) { toast.error("Fichier trop volumineux (2 Mo maximum)."); return }
    setLoading(true)
    try {
      const t = await file.text(); setText(t); setFileName(file.name)
      const r = await previewBankCsvAction(t)
      if (!r.ok) { toast.error(r.error); return }
      setHeader(r.header); setSample(r.sample); setMapping(r.mapping); setMode(r.mapping.amount !== undefined ? "amount" : "debitcredit")
    } catch { toast.error("Lecture du fichier impossible.") } finally { setLoading(false) }
  }
  async function submit() {
    if (!mapping) return
    setLoading(true)
    try {
      const m: Mapping = mode === "amount" ? { ...mapping, debit: undefined, credit: undefined } : { ...mapping, amount: undefined }
      const r = await importBankStatementAction({ text, fileName, mapping: m })
      if (!r.ok) { toast.error(r.error); return }
      toast.success(`${r.imported} opération(s) importée(s), ${r.duplicates} doublon(s) certain(s) ignoré(s)${r.collisions ? `, ${r.collisions} collision(s) à résoudre (tuple déjà connu d'un relevé antérieur)` : ""}${r.invalid.length ? `, ${r.invalid.length} ligne(s) invalide(s)` : ""}.`)
      setOpen(false); setMapping(null); router.refresh()
    } catch { toast.error("Erreur serveur : import non effectué.") } finally { setLoading(false) }
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button variant="outline"><Upload className="h-4 w-4" /> Importer un relevé CSV</Button></DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Importer un relevé bancaire (CSV)</DialogTitle></DialogHeader>
        <input type="file" accept=".csv,text/csv" disabled={loading} onChange={(e) => void onFile(e.target.files?.[0])} className="text-sm" />
        {loading && <p className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" /> Traitement…</p>}
        {mapping && (
          <div className="space-y-3 text-sm">
            <p className="text-slate-600">Vérifiez la correspondance des colonnes. Un relevé déjà importé ou une ligne déjà présente sont ignorés (aucun doublon).</p>
            <div className="flex gap-3"><label className="flex items-center gap-1"><input type="radio" checked={mode === "amount"} onChange={() => setMode("amount")} /> Colonne montant signé</label><label className="flex items-center gap-1"><input type="radio" checked={mode === "debitcredit"} onChange={() => setMode("debitcredit")} /> Colonnes débit / crédit</label></div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Sel k="date" label="Date" header={header} mapping={mapping} onChange={setMapping} /><Sel k="label" label="Libellé" header={header} mapping={mapping} onChange={setMapping} />
              {mode === "amount" ? <Sel k="amount" label="Montant" header={header} mapping={mapping} onChange={setMapping} /> : <><Sel k="debit" label="Débit" header={header} mapping={mapping} onChange={setMapping} /><Sel k="credit" label="Crédit" header={header} mapping={mapping} onChange={setMapping} /></>}
              <Sel k="reference" label="Référence" optional header={header} mapping={mapping} onChange={setMapping} /><Sel k="bankId" label="Identifiant bancaire (unique, recommandé)" optional header={header} mapping={mapping} onChange={setMapping} />
            </div>
            <div className="max-h-40 overflow-auto rounded border"><table className="w-full text-xs"><thead className="bg-slate-50"><tr>{header.map((h, i) => <th key={i} className="px-2 py-1 text-left">{h}</th>)}</tr></thead><tbody>{sample.map((r, i) => <tr key={i} className="border-t">{r.map((c, j) => <td key={j} className="px-2 py-1">{c}</td>)}</tr>)}</tbody></table></div>
            <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setOpen(false)}>Annuler</Button><Button disabled={loading} onClick={() => void submit()}>Importer</Button></div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
