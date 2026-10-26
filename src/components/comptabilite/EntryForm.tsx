"use client"
// Saisie d'une écriture (SPEC-ACC-A2) : lignes dynamiques, totaux et écart en direct, brouillon ou validation.
import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { saveEntryAction } from "@/lib/accounting/actions/accounting.actions"
import { entryTotals, formatEuros } from "@/lib/accounting/ui/forms"

type Option = { id: string; label: string }
type Line = { key: number; accountId: string; label: string; debit: string; credit: string }

const selectClass = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm"

export function EntryForm({ journals, years, accounts, defaultYearId, defaultDate }: {
  journals: Option[]; years: Option[]; accounts: Option[]; defaultYearId: string; defaultDate: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<null | "draft" | "post">(null)
  const [journalId, setJournalId] = useState(journals[0]?.id ?? "")
  const [fiscalYearId, setFiscalYearId] = useState(defaultYearId)
  const [entryDate, setEntryDate] = useState(defaultDate)
  const [documentRef, setDocumentRef] = useState("")
  const [label, setLabel] = useState("")
  const [nextKey, setNextKey] = useState(3)
  const [lines, setLines] = useState<Line[]>([
    { key: 1, accountId: "", label: "", debit: "", credit: "" },
    { key: 2, accountId: "", label: "", debit: "", credit: "" },
  ])
  const totals = useMemo(() => entryTotals(lines), [lines])
  const gap = totals.debitCents - totals.creditCents
  const balanced = totals.valid && gap === BigInt(0) && totals.debitCents > BigInt(0)

  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  const addLine = () => { setLines((ls) => [...ls, { key: nextKey, accountId: "", label: "", debit: "", credit: "" }]); setNextKey((k) => k + 1) }
  const removeLine = (key: number) => setLines((ls) => (ls.length > 2 ? ls.filter((l) => l.key !== key) : ls))

  async function submit(validate: boolean) {
    if (validate && !window.confirm("Enregistrer et valider ? L'écriture sera numérotée et ne pourra plus être modifiée.")) return
    setBusy(validate ? "post" : "draft")
    try {
      const r = await saveEntryAction({
        journalId, fiscalYearId, entryDate, documentRef, label,
        lines: lines.map((l) => ({ accountId: l.accountId, label: l.label, debit: l.debit, credit: l.credit, vatRateBp: "" })),
      }, validate)
      if (!r.ok) { toast.error(r.error); return }
      toast.success(validate ? `Écriture validée (n° ${r.number}).` : "Brouillon enregistré.")
      router.push(`/comptabilite/ecritures/${r.id}`)
    } catch { toast.error("Erreur serveur : écriture non enregistrée.") }
    finally { setBusy(null) }
  }

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(false) }}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1"><Label htmlFor="e-journal">Journal</Label>
          <select id="e-journal" className={selectClass} value={journalId} onChange={(e) => setJournalId(e.target.value)} required>
            {journals.map((j) => <option key={j.id} value={j.id}>{j.label}</option>)}
          </select></div>
        <div className="space-y-1"><Label htmlFor="e-year">Exercice</Label>
          <select id="e-year" className={selectClass} value={fiscalYearId} onChange={(e) => setFiscalYearId(e.target.value)} required>
            {years.map((y) => <option key={y.id} value={y.id}>{y.label}</option>)}
          </select></div>
        <div className="space-y-1"><Label htmlFor="e-date">Date</Label><Input id="e-date" type="date" required value={entryDate} onChange={(e) => setEntryDate(e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="e-ref">Pièce</Label><Input id="e-ref" maxLength={100} value={documentRef} onChange={(e) => setDocumentRef(e.target.value)} placeholder="ex. FAC-2026-0001" /></div>
      </div>
      <div className="space-y-1"><Label htmlFor="e-label">Libellé</Label><Input id="e-label" required maxLength={300} value={label} onChange={(e) => setLabel(e.target.value)} /></div>

      <div className="overflow-x-auto rounded-md border border-slate-200">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-slate-50 text-left text-slate-600">
            <tr><th className="p-2">Compte</th><th className="p-2">Libellé de ligne</th><th className="p-2 text-right">Débit</th><th className="p-2 text-right">Crédit</th><th className="p-2" /></tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.key} className="border-t border-slate-100">
                <td className="p-2"><select aria-label={`Compte ligne ${i + 1}`} className={selectClass} value={l.accountId} required onChange={(e) => update(l.key, { accountId: e.target.value })}>
                  <option value="">— Choisir —</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select></td>
                <td className="p-2"><Input aria-label={`Libellé ligne ${i + 1}`} maxLength={300} value={l.label} onChange={(e) => update(l.key, { label: e.target.value })} /></td>
                <td className="p-2"><Input aria-label={`Débit ligne ${i + 1}`} inputMode="decimal" className="text-right" value={l.debit} onChange={(e) => update(l.key, { debit: e.target.value, credit: e.target.value ? "" : l.credit })} placeholder="0,00" /></td>
                <td className="p-2"><Input aria-label={`Crédit ligne ${i + 1}`} inputMode="decimal" className="text-right" value={l.credit} onChange={(e) => update(l.key, { credit: e.target.value, debit: e.target.value ? "" : l.debit })} placeholder="0,00" /></td>
                <td className="p-2 text-right"><Button type="button" variant="ghost" size="icon" aria-label={`Supprimer la ligne ${i + 1}`} disabled={lines.length <= 2} onClick={() => removeLine(l.key)}><Trash2 /></Button></td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-slate-200 bg-slate-50 font-medium">
            <tr>
              <td className="p-2" colSpan={2}><Button type="button" variant="outline" size="sm" onClick={addLine} disabled={lines.length >= 500}><Plus /> Ajouter une ligne</Button></td>
              <td className="p-2 text-right tabular-nums">{totals.valid ? formatEuros(totals.debitCents) : "—"}</td>
              <td className="p-2 text-right tabular-nums">{totals.valid ? formatEuros(totals.creditCents) : "—"}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className={balanced ? "text-sm text-green-700" : "text-sm text-amber-700"} role="status">
        {!totals.valid ? "Un montant est invalide (format 1234,56)." : balanced ? "Écriture équilibrée." : `Écart débit − crédit : ${formatEuros(gap)}`}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="outline" disabled={busy !== null}>{busy === "draft" && <Loader2 className="animate-spin" />} Enregistrer en brouillon</Button>
        <Button type="button" disabled={busy !== null || !balanced} onClick={() => submit(true)}>{busy === "post" && <Loader2 className="animate-spin" />} Enregistrer et valider</Button>
      </div>
    </form>
  )
}
