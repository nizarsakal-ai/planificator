"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { FileText, Loader2, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { createInvoice } from "@/lib/actions/invoice.actions"

export interface WorksiteOption {
  id: string
  name: string
  clientName: string
  startDate: string
  endDate: string
}

export interface ArticleOption {
  id: string
  designation: string
  unit: string
  unitPrice: number
  vatRate: number
}

interface LineRow {
  articleId: string | null
  designation: string
  unit: string
  quantity: number
  unitPrice: number
  vatRate: number
}

const eur = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" })

function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

function emptyLine(): LineRow {
  return { articleId: null, designation: "", unit: "u", quantity: 1, unitPrice: 0, vatRate: 20 }
}

export function NouvelleFactureDialog({
  worksites,
  articles,
}: {
  worksites: WorksiteOption[]
  articles: ArticleOption[]
}) {
  const router = useRouter()
  const [open, setOpen]           = useState(false)
  const [loading, setLoading]     = useState(false)
  const [worksiteId, setWorksiteId] = useState("")
  const [dueDate, setDueDate]     = useState("")
  const [notes, setNotes]         = useState("")
  const [lines, setLines]         = useState<LineRow[]>([emptyLine()])

  const worksite = worksites.find((w) => w.id === worksiteId)

  const totals = useMemo(() => {
    let totalHT = 0
    let totalVAT = 0
    for (const l of lines) {
      const ht = round2(l.quantity * l.unitPrice)
      totalHT += ht
      totalVAT += round2(ht * (l.vatRate / 100))
    }
    totalHT = round2(totalHT)
    totalVAT = round2(totalVAT)
    return { totalHT, totalVAT, totalTTC: round2(totalHT + totalVAT) }
  }, [lines])

  function updateLine(i: number, patch: Partial<LineRow>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  }

  function pickArticle(i: number, articleId: string) {
    if (!articleId) {
      updateLine(i, { articleId: null })
      return
    }
    const a = articles.find((x) => x.id === articleId)
    if (!a) return
    updateLine(i, {
      articleId:   a.id,
      designation: a.designation,
      unit:        a.unit,
      unitPrice:   a.unitPrice,
      vatRate:     a.vatRate,
    })
  }

  function reset() {
    setWorksiteId("")
    setDueDate("")
    setNotes("")
    setLines([emptyLine()])
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!worksiteId) {
      toast.error("Sélectionnez un chantier.")
      return
    }
    const validLines = lines.filter((l) => l.designation.trim() !== "")
    if (validLines.length === 0) {
      toast.error("Ajoutez au moins une ligne.")
      return
    }
    setLoading(true)
    const result = await createInvoice({
      worksiteId,
      dueDate: dueDate || null,
      notes:   notes || null,
      lines:   validLines,
    })
    setLoading(false)

    if (result?.error) {
      toast.error(result.error)
    } else {
      toast.success(`Facture ${result.number} créée.`)
      setOpen(false)
      reset()
      router.refresh()
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v) reset()
      }}
    >
      <DialogTrigger asChild>
        <Button className="bg-[#0f3460] hover:bg-[#0a2540] gap-1.5">
          <Plus className="h-4 w-4" />
          Nouvelle facture
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-[#0f3460]" />
            Nouvelle facture
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Chantier + échéance */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-slate-500">Chantier *</Label>
              <select
                value={worksiteId}
                onChange={(e) => setWorksiteId(e.target.value)}
                required
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0f3460]/20"
              >
                <option value="">Sélectionner…</option>
                {worksites.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} — {w.clientName}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-slate-500">Échéance</Label>
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
          </div>

          {worksite && (
            <p className="text-xs text-slate-400">
              Client : <span className="text-slate-600">{worksite.clientName}</span> · Période facturée :{" "}
              <span className="text-slate-600">
                {worksite.startDate} → {worksite.endDate}
              </span>
            </p>
          )}

          {/* Lignes */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-slate-500">Lignes</Label>
              <button
                type="button"
                onClick={() => setLines((prev) => [...prev, emptyLine()])}
                className="flex items-center gap-1 text-xs text-[#0f3460] hover:underline"
              >
                <Plus className="h-3.5 w-3.5" /> Ajouter une ligne
              </button>
            </div>

            <div className="space-y-2">
              {lines.map((l, i) => (
                <div key={i} className="rounded-md border border-slate-100 bg-slate-50/40 p-2 space-y-2">
                  <div className="grid grid-cols-12 gap-2">
                    <select
                      value={l.articleId ?? ""}
                      onChange={(e) => pickArticle(i, e.target.value)}
                      className="col-span-4 rounded-md border border-input bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#0f3460]/20"
                    >
                      <option value="">Ligne libre…</option>
                      {articles.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.designation}
                        </option>
                      ))}
                    </select>
                    <Input
                      value={l.designation}
                      onChange={(e) => updateLine(i, { designation: e.target.value })}
                      placeholder="Désignation"
                      className="col-span-8 h-8 text-xs"
                    />
                  </div>
                  <div className="grid grid-cols-12 gap-2 items-center">
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={l.quantity}
                      onChange={(e) => updateLine(i, { quantity: Number(e.target.value) })}
                      placeholder="Qté"
                      className="col-span-2 h-8 text-xs"
                      title="Quantité"
                    />
                    <Input
                      value={l.unit}
                      onChange={(e) => updateLine(i, { unit: e.target.value })}
                      placeholder="u"
                      className="col-span-2 h-8 text-xs"
                      title="Unité"
                    />
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={l.unitPrice}
                      onChange={(e) => updateLine(i, { unitPrice: Number(e.target.value) })}
                      placeholder="Prix HT"
                      className="col-span-2 h-8 text-xs"
                      title="Prix unitaire HT"
                    />
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      max="100"
                      value={l.vatRate}
                      onChange={(e) => updateLine(i, { vatRate: Number(e.target.value) })}
                      placeholder="TVA %"
                      className="col-span-2 h-8 text-xs"
                      title="TVA %"
                    />
                    <span className="col-span-3 text-right text-xs tabular-nums text-slate-600">
                      {eur.format(round2(l.quantity * l.unitPrice))}
                    </span>
                    <button
                      type="button"
                      onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
                      disabled={lines.length === 1}
                      className="col-span-1 flex justify-center text-slate-300 hover:text-red-500 disabled:opacity-30"
                      title="Supprimer la ligne"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Totaux */}
          <div className="flex justify-end">
            <div className="w-56 space-y-1 text-sm">
              <div className="flex justify-between text-slate-500">
                <span>Total HT</span>
                <span className="tabular-nums">{eur.format(totals.totalHT)}</span>
              </div>
              <div className="flex justify-between text-slate-500">
                <span>TVA</span>
                <span className="tabular-nums">{eur.format(totals.totalVAT)}</span>
              </div>
              <div className="flex justify-between font-semibold text-slate-800 border-t pt-1">
                <span>Total TTC</span>
                <span className="tabular-nums">{eur.format(totals.totalTTC)}</span>
              </div>
            </div>
          </div>

          {/* Notes */}
          <div className="space-y-1">
            <Label className="text-xs text-slate-500">Notes</Label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Mentions, conditions de paiement…"
              rows={2}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#0f3460]/20"
            />
          </div>

          <Button type="submit" disabled={loading} className="w-full bg-[#0f3460] hover:bg-[#0a2540]">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Créer la facture (brouillon)"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
