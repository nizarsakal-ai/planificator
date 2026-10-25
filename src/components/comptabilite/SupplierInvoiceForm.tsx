"use client"
// Saisie / vérification d'une facture fournisseur : import ou capture (caméra) du fichier, extraction OCR (si activée), champs avec confiance.
import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent } from "@/components/ui/card"
import { createSupplierInvoiceAction, updateSupplierInvoiceAction, uploadSupplierFileAction } from "@/lib/actions/accounting-c5.actions"

export interface SupplierFormValues { supplierName: string; siret: string; number: string; date: string; dueDate: string; totalHT: string; vat: string; totalTTC: string; vatRate: string; category: string; expenseAccountId: string; notes: string }
const CATS = [["", "—"], ["marchandises", "Marchandises"], ["services", "Prestations"], ["location", "Locations"], ["deplacement", "Déplacements"], ["honoraires", "Honoraires"], ["entretien", "Entretien"], ["autre", "Autre"]]
const empty: SupplierFormValues = { supplierName: "", siret: "", number: "", date: new Date().toISOString().slice(0, 10), dueDate: "", totalHT: "", vat: "", totalTTC: "", vatRate: "20", category: "", expenseAccountId: "", notes: "" }

function Conf({ c }: { c?: number }) { if (c === undefined) return null; const pct = Math.round(c * 100); return <span className={`ml-1 text-[10px] ${pct >= 80 ? "text-green-700" : pct >= 50 ? "text-amber-700" : "text-red-700"}`} title="Confiance de l'extraction">{pct} %</span> }

export function SupplierInvoiceForm({ mode, invoiceId, initial, accounts, confidence = {}, fileId: initialFileId = null, fileMime = null }: { mode: "create" | "edit"; invoiceId?: string; initial?: SupplierFormValues; accounts: { id: string; number: string; label: string }[]; confidence?: Record<string, number>; fileId?: string | null; fileMime?: string | null }) {
  const router = useRouter()
  const [v, setV] = useState<SupplierFormValues>(initial ?? empty)
  const [conf, setConf] = useState<Record<string, number>>(confidence)
  const [fileId, setFileId] = useState<string | null>(initialFileId)
  const [ocr, setOcr] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(false)
  const set = (k: keyof SupplierFormValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value })
  void fileMime

  async function onFile(file: File | undefined) {
    if (!file) return
    setLoading(true)
    try {
      const fd = new FormData(); fd.append("file", file)
      const r = await uploadSupplierFileAction(fd)
      if (!r.ok) { toast.error(r.error); return }
      setFileId(r.fileId)
      if (r.extraction) {
        const e = r.extraction as Record<string, unknown>
        const cents = (x: unknown) => (typeof x === "string" ? (Number(x) / 100).toFixed(2) : "")
        setV({ ...v, supplierName: (e.supplier as string) ?? v.supplierName, siret: (e.siret as string) ?? "", number: (e.invoiceNumber as string) ?? v.number, date: (e.date as string) ?? v.date, totalHT: cents(e.totalHTCents) || v.totalHT, vat: cents(e.vatCents) || v.vat, totalTTC: cents(e.totalTTCCents) || v.totalTTC, vatRate: typeof e.vatRateBp === "number" ? String(e.vatRateBp / 100) : v.vatRate, category: (e.category as string) ?? v.category })
        setConf((e.confidence as Record<string, number>) ?? {}); setOcr(e)
        toast.success("Champs extraits : vérifiez chaque valeur avant validation.")
      } else toast.info(r.extractionError ?? "Fichier enregistré : saisissez les champs manuellement.")
    } catch { toast.error("Erreur serveur : fichier non traité.") } finally { setLoading(false) }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setLoading(true)
    try {
      const payload = { ...v, category: v.category || undefined, expenseAccountId: v.expenseAccountId || undefined, siret: v.siret || undefined, dueDate: v.dueDate || "", vatRate: v.vatRate || undefined, notes: v.notes || undefined }
      if (mode === "create") {
        const r = await createSupplierInvoiceAction({ ...payload, fileId: fileId ?? undefined, ocr: ocr ? { ...ocr, rawText: undefined } : null })
        if (!r.ok) { toast.error(r.error); return }
        toast.success("Facture fournisseur enregistrée (à valider)."); router.push(`/comptabilite/fournisseurs/${r.id}`)
      } else {
        const r = await updateSupplierInvoiceAction(invoiceId, payload)
        if (!r.ok) { toast.error(r.error); return }
        toast.success("Facture mise à jour.")
      }
      router.refresh()
    } catch { toast.error("Erreur serveur.") } finally { setLoading(false) }
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      {mode === "create" && <Card><CardContent className="space-y-2 p-4 text-sm">
        <p className="font-medium text-slate-700">1. Fichier de la facture (JPEG, PNG, WebP ou PDF, 10 Mo max)</p>
        <div className="flex flex-wrap gap-3"><label className="flex flex-col gap-1 text-xs">Importer<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" disabled={loading} onChange={(e) => void onFile(e.target.files?.[0])} /></label><label className="flex flex-col gap-1 text-xs">Scanner (caméra)<input type="file" accept="image/*" capture="environment" disabled={loading} onChange={(e) => void onFile(e.target.files?.[0])} /></label></div>
        {fileId && <p className="text-xs text-green-700">Fichier enregistré.</p>}{loading && <p className="flex items-center gap-2 text-xs"><Loader2 className="h-3 w-3 animate-spin" /> Traitement…</p>}
      </CardContent></Card>}
      <Card><CardContent className="grid gap-3 p-4 sm:grid-cols-2">
        <div><Label htmlFor="sn">Fournisseur *<Conf c={conf.supplier} /></Label><Input id="sn" required value={v.supplierName} onChange={set("supplierName")} /></div>
        <div><Label htmlFor="si">SIRET (14 chiffres)<Conf c={conf.siret} /></Label><Input id="si" value={v.siret} onChange={set("siret")} /></div>
        <div><Label htmlFor="nu">N° de facture *<Conf c={conf.invoiceNumber} /></Label><Input id="nu" required value={v.number} onChange={set("number")} /></div>
        <div><Label htmlFor="da">Date *<Conf c={conf.date} /></Label><Input id="da" type="date" required value={v.date} onChange={set("date")} /></div>
        <div><Label htmlFor="du">Échéance</Label><Input id="du" type="date" value={v.dueDate} onChange={set("dueDate")} /></div>
        <div><Label htmlFor="vr">Taux de TVA (%)<Conf c={conf.vatRate} /></Label><Input id="vr" value={v.vatRate} onChange={set("vatRate")} /></div>
        <div><Label htmlFor="ht">Montant HT *<Conf c={conf.amountHT} /></Label><Input id="ht" inputMode="decimal" required value={v.totalHT} onChange={set("totalHT")} /></div>
        <div><Label htmlFor="tv">TVA *<Conf c={conf.vatAmount} /></Label><Input id="tv" inputMode="decimal" required value={v.vat} onChange={set("vat")} /></div>
        <div><Label htmlFor="tt">TTC *<Conf c={conf.amountTTC} /></Label><Input id="tt" inputMode="decimal" required value={v.totalTTC} onChange={set("totalTTC")} /></div>
        <div><Label htmlFor="ca">Catégorie</Label><select id="ca" value={v.category} onChange={set("category")} className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm">{CATS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div className="sm:col-span-2"><Label htmlFor="ac">Compte de charge (défaut selon la catégorie)</Label><select id="ac" value={v.expenseAccountId} onChange={set("expenseAccountId")} className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="">— Selon la catégorie —</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.number} {a.label}</option>)}</select></div>
        <div className="sm:col-span-2"><Label htmlFor="no">Notes</Label><Input id="no" maxLength={1000} value={v.notes} onChange={set("notes")} /></div>
      </CardContent></Card>
      <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => router.back()}>Annuler</Button><Button type="submit" disabled={loading}>{loading && <Loader2 className="h-4 w-4 animate-spin" />} {mode === "create" ? "Enregistrer (à valider)" : "Enregistrer les corrections"}</Button></div>
    </form>
  )
}
