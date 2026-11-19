"use client"
// Changement en masse « Non précisé » → « Payée » d'un lot d'import validé (amendement SPEC-INVOICE-IMPORT-001 §5).
// Deux temps obligatoires : vérification (liste exacte, aucune écriture) puis confirmation avec le nombre vérifié.
import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { applyMarkImportedPaidAction, previewMarkImportedPaidAction, type MarkPaidPreview } from "@/lib/actions/invoice-import.actions"

const dateFr = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" })

/** Centimes signés (chaîne) → « −1 234,56 € », sans flottant. */
function euros(cents: string): string {
  const neg = cents.startsWith("-")
  const abs = (neg ? cents.slice(1) : cents).padStart(3, "0")
  const units = abs.slice(0, -2).replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, " ")
  return `${neg ? "−" : ""}${units},${abs.slice(-2)} €`
}

interface Props { batchId: string; label: string; count: number }

export function ImportedBulkMarkPaid({ batchId, label, count }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<MarkPaidPreview | null>(null)

  async function check() {
    setBusy(true)
    try {
      const r = await previewMarkImportedPaidAction(batchId)
      if (!r.ok) { toast.error(r.error); return }
      if (r.preview.count === 0) { toast.info("Rien à modifier : déjà appliqué."); router.refresh(); return }
      setPreview(r.preview)
    } finally { setBusy(false) }
  }

  async function apply() {
    if (!preview) return
    setBusy(true)
    try {
      const r = await applyMarkImportedPaidAction(batchId, preview.count)
      if (!r.ok) { toast.error(r.error); setPreview(null); router.refresh(); return }
      toast.success(`${r.updated} pièce(s) marquée(s) « Payée ».`)
      setPreview(null)
      router.refresh()
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-2 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>{label} : <strong>{count}</strong> pièce{count > 1 ? "s" : ""} au statut « Non précisé »</span>
        {!preview && <Button type="button" variant="outline" onClick={check} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Marquer comme payées…</Button>}
      </div>
      {preview && (
        <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3">
          <p className="font-medium text-amber-950">
            {preview.count} pièce(s) passeront de « Non précisé » à « Payée » : {preview.invoiceCount} facture(s) ({euros(preview.invoicesTTCCents)}),
            {" "}{preview.creditNoteCount} avoir(s) ({euros(preview.creditNotesTTCCents)}). Net encaissé ajouté : <strong>{euros(preview.netTTCCents)}</strong>.
          </p>
          <p className="text-xs text-amber-900">Un avoir « Payé » est considéré remboursé ou imputé : il vient en déduction de l’encaissé. Montants, numéros, PDF et statut d’origine ne changent pas. Chaque changement est journalisé.</p>
          <div className="max-h-64 overflow-auto rounded border bg-white">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-left uppercase text-slate-500"><tr><th className="px-2 py-1">N°</th><th className="px-2 py-1">Client</th><th className="px-2 py-1">Date</th><th className="px-2 py-1 text-right">TTC</th></tr></thead>
              <tbody>{preview.items.map((i) => (
                <tr key={i.id} className="border-t"><td className="px-2 py-1">{i.number}{i.kind === "CREDIT_NOTE" && <span className="ml-1 text-indigo-700">(avoir)</span>}</td><td className="px-2 py-1">{i.clientName}</td><td className="px-2 py-1">{dateFr.format(new Date(`${i.issueDate}T00:00:00Z`))}</td><td className="px-2 py-1 text-right tabular-nums">{euros(i.signedTTCCents)}</td></tr>
              ))}</tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={apply} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Confirmer ({preview.count})</Button>
            <Button type="button" variant="ghost" onClick={() => setPreview(null)} disabled={busy}>Annuler</Button>
          </div>
        </div>
      )}
    </div>
  )
}
