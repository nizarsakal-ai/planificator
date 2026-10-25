"use client"
// Formulaire de devis (création / modification d'un brouillon). Montants saisis en chaînes ; totaux calculés en centimes.
import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent } from "@/components/ui/card"
import { createQuoteAction, updateQuoteAction } from "@/lib/actions/quote.actions"
import { previewQuoteTotals, type QuoteFormInput, type QuoteLineFormInput } from "@/lib/billing/quotes/quote-schemas"
import { bpToPercentString, formatEuro } from "@/lib/billing/money"

export interface WorksiteOption { id: string; name: string; clientId: string; clientName: string; clientEmail: string | null }
export interface ArticleOption { id: string; designation: string; unit: string; unitPrice: string; vatRate: string }

const VAT_OPTIONS = ["20", "10", "5.5", "2.1", "0"]

function emptyLine(): QuoteLineFormInput {
  return { articleId: null, designation: "", description: "", unit: "u", quantity: "1", unitPrice: "", discount: "", vatRate: "20" }
}

export function QuoteForm({ mode, quoteId, initial, worksites, articles }: {
  mode: "create" | "edit"; quoteId?: string; initial?: QuoteFormInput; worksites: WorksiteOption[]; articles: ArticleOption[]
}) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState<QuoteFormInput>(initial ?? {
    worksiteId: worksites[0]?.id ?? "", issueDate: new Date().toISOString().slice(0, 10), validUntil: "", subject: "", notes: "", paymentTerms: "",
    globalDiscount: "", vatReverseCharge: false, lines: [emptyLine()],
  })
  const worksite = worksites.find((w) => w.id === form.worksiteId)
  const totals = useMemo(() => previewQuoteTotals(form.lines, form.globalDiscount ?? "", form.vatReverseCharge === true), [form.lines, form.globalDiscount, form.vatReverseCharge])

  const setLine = (i: number, patch: Partial<QuoteLineFormInput>) =>
    setForm((f) => ({ ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }))
  const pickArticle = (i: number, articleId: string) => {
    const a = articles.find((x) => x.id === articleId)
    if (!a) { setLine(i, { articleId: null }); return }
    if (!VAT_OPTIONS.includes(a.vatRate)) toast.warning(`Taux de TVA de l'article (${a.vatRate} %) hors liste : 20 % appliqué, à vérifier.`)
    setLine(i, { articleId: a.id, designation: a.designation, unit: a.unit, unitPrice: a.unitPrice, vatRate: VAT_OPTIONS.includes(a.vatRate) ? a.vatRate : "20" })
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      if (mode === "create") {
        const r = await createQuoteAction(form)
        if (!r.ok) { toast.error(r.error); return }
        toast.success(`Devis ${r.number} créé.`)
        router.push(`/devis/${r.id}`)
      } else {
        const r = await updateQuoteAction(quoteId, form)
        if (!r.ok) { toast.error(r.error); return }
        toast.success("Devis enregistré.")
        router.push(`/devis/${quoteId}`)
      }
      router.refresh()
    } catch {
      toast.error("Erreur serveur : devis non enregistré.")
    } finally { setLoading(false) }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Card><CardContent className="grid gap-3 p-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Label htmlFor="worksite">Chantier *</Label>
          <select id="worksite" required value={form.worksiteId} onChange={(e) => setForm({ ...form, worksiteId: e.target.value })} className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
            <option value="">— Choisir —</option>
            {worksites.map((w) => <option key={w.id} value={w.id}>{w.name} — {w.clientName}</option>)}
          </select>
          {worksite && <p className="mt-1 text-xs text-slate-500">Client : {worksite.clientName}{worksite.clientEmail ? ` · ${worksite.clientEmail}` : " · aucun e-mail (envoi impossible)"}</p>}
        </div>
        <div><Label htmlFor="issueDate">Date *</Label><Input id="issueDate" type="date" required value={form.issueDate} onChange={(e) => setForm({ ...form, issueDate: e.target.value })} /></div>
        <div><Label htmlFor="validUntil">Valable jusqu&apos;au</Label><Input id="validUntil" type="date" value={form.validUntil ?? ""} onChange={(e) => setForm({ ...form, validUntil: e.target.value })} /></div>
        <div className="sm:col-span-2"><Label htmlFor="subject">Objet</Label><Input id="subject" maxLength={200} value={form.subject ?? ""} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></div>
      </CardContent></Card>

      <Card><CardContent className="space-y-2 p-4">
        <div className="hidden grid-cols-12 gap-2 text-xs font-medium text-slate-500 sm:grid">
          <span className="col-span-4">Désignation</span><span>Unité</span><span>Qté</span><span className="col-span-2">PU HT</span><span>Remise %</span><span>TVA %</span><span className="col-span-2 text-right">Total HT</span>
        </div>
        {form.lines.map((l, i) => (
          <div key={i} className="grid grid-cols-2 gap-2 rounded border border-slate-100 p-2 sm:grid-cols-12 sm:border-0 sm:p-0">
            <div className="col-span-2 sm:col-span-4 space-y-1">
              {articles.length > 0 && (
                <select aria-label="Article" value={l.articleId ?? ""} onChange={(e) => pickArticle(i, e.target.value)} className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs">
                  <option value="">Article du catalogue…</option>
                  {articles.map((a) => <option key={a.id} value={a.id}>{a.designation}</option>)}
                </select>
              )}
              <Input aria-label="Désignation" required maxLength={200} placeholder="Désignation" value={l.designation} onChange={(e) => setLine(i, { designation: e.target.value })} />
              <Input aria-label="Description" maxLength={1000} placeholder="Description (facultatif)" value={l.description ?? ""} onChange={(e) => setLine(i, { description: e.target.value })} className="h-8 text-xs" />
            </div>
            <Input aria-label="Unité" maxLength={20} value={l.unit ?? "u"} onChange={(e) => setLine(i, { unit: e.target.value })} />
            <Input aria-label="Quantité" inputMode="decimal" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
            <Input aria-label="Prix unitaire HT" inputMode="decimal" className="sm:col-span-2" placeholder="0,00" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} />
            <Input aria-label="Remise %" inputMode="decimal" placeholder="0" value={l.discount ?? ""} onChange={(e) => setLine(i, { discount: e.target.value })} />
            <select aria-label="TVA %" value={l.vatRate} onChange={(e) => setLine(i, { vatRate: e.target.value })} className="h-10 rounded-md border border-input bg-background px-2 text-sm">
              {VAT_OPTIONS.map((v) => <option key={v} value={v}>{v} %</option>)}
            </select>
            <div className="col-span-2 flex items-center justify-between gap-2 sm:col-span-2 sm:justify-end">
              <span className="text-sm tabular-nums">{totals ? formatEuro(totals.lines[i].lineHTCents) : "—"}</span>
              <button type="button" aria-label="Supprimer la ligne" onClick={() => setForm((f) => ({ ...f, lines: f.lines.length > 1 ? f.lines.filter((_, j) => j !== i) : f.lines }))} className="text-slate-400 hover:text-red-500"><Trash2 className="h-4 w-4" /></button>
            </div>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, emptyLine()] }))}><Plus className="h-4 w-4" /> Ajouter une ligne</Button>
      </CardContent></Card>

      <Card><CardContent className="grid gap-3 p-4 sm:grid-cols-2">
        <div className="space-y-3">
          <div><Label htmlFor="globalDiscount">Remise globale (%)</Label><Input id="globalDiscount" inputMode="decimal" value={form.globalDiscount ?? ""} onChange={(e) => setForm({ ...form, globalDiscount: e.target.value })} /></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.vatReverseCharge === true} onChange={(e) => setForm({ ...form, vatReverseCharge: e.target.checked })} /> Autoliquidation de la TVA (art. 283-2 nonies CGI)</label>
          <div><Label htmlFor="paymentTerms">Conditions de paiement</Label><Input id="paymentTerms" maxLength={500} placeholder="Ex. : 30 % à la commande, solde à réception" value={form.paymentTerms ?? ""} onChange={(e) => setForm({ ...form, paymentTerms: e.target.value })} /></div>
          <div><Label htmlFor="notes">Notes / conditions particulières</Label><Textarea id="notes" maxLength={2000} value={form.notes ?? ""} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
        </div>
        <div className="rounded-md bg-slate-50 p-3 text-sm">
          {totals ? (
            <dl className="space-y-1 tabular-nums">
              <div className="flex justify-between"><dt>Sous-total HT</dt><dd>{formatEuro(totals.subtotalCents)}</dd></div>
              {totals.globalDiscountCents > BigInt(0) && <div className="flex justify-between text-slate-500"><dt>Remise globale</dt><dd>−{formatEuro(totals.globalDiscountCents)}</dd></div>}
              <div className="flex justify-between font-medium"><dt>Total HT</dt><dd>{formatEuro(totals.totalHTCents)}</dd></div>
              {totals.vatSummary.map((v) => <div key={v.vatRateBp} className="flex justify-between text-slate-600"><dt>TVA {bpToPercentString(v.vatRateBp)} % sur {formatEuro(v.baseCents)}</dt><dd>{formatEuro(v.vatCents)}</dd></div>)}
              <div className="flex justify-between border-t pt-1 text-base font-semibold"><dt>Total TTC</dt><dd>{formatEuro(totals.totalTTCCents)}</dd></div>
            </dl>
          ) : <p className="text-red-600">Saisie invalide : vérifiez quantités, prix, remises et taux.</p>}
        </div>
      </CardContent></Card>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.back()}>Annuler</Button>
        <Button type="submit" disabled={loading || !totals}>{loading && <Loader2 className="h-4 w-4 animate-spin" />} {mode === "create" ? "Créer le devis" : "Enregistrer"}</Button>
      </div>
    </form>
  )
}
