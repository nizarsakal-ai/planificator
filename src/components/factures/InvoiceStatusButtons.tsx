"use client"

import { useState } from "react"
import { Loader2, Send, CheckCircle2, XCircle, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { createCreditNote, updateInvoiceStatus } from "@/lib/actions/invoice.actions"

type Status = "DRAFT" | "SENT" | "PAID" | "CANCELLED"
type Kind = "INVOICE" | "CREDIT_NOTE"
type Action = "SENT" | "PAID" | "CANCELLED" | "CREDIT"

/**
 * Lot B : automate irréversible. Brouillon → envoyer ou abandonner ; envoyée → payée ;
 * une facture envoyée ou payée ne s'annule que par un avoir. Un avoir n'a aucune action.
 */
export function InvoiceStatusButtons({ id, status, kind = "INVOICE" }: { id: string; status: Status; kind?: Kind }) {
  const router = useRouter()
  const [loading, setLoading] = useState<Action | null>(null)

  async function set(next: "SENT" | "PAID" | "CANCELLED") {
    if (next === "SENT" && !window.confirm("Émettre cette facture ? Elle ne pourra plus être modifiée.")) return
    if (next === "CANCELLED" && !window.confirm("Abandonner ce brouillon ? Il restera dans l'historique.")) return
    setLoading(next)
    const result = await updateInvoiceStatus(id, next)
    setLoading(null)
    if (result?.error) {
      toast.error(result.error)
    } else {
      toast.success(
        next === "SENT" ? "Facture émise." :
        next === "PAID" ? "Facture marquée payée." :
        "Brouillon abandonné."
      )
      router.refresh()
    }
  }

  async function credit() {
    const reason = window.prompt(
      "Émettre un avoir total sur cette facture ? Elle passera à « annulée ».\nMotif (facultatif) :",
      ""
    )
    if (reason === null) return
    setLoading("CREDIT")
    const result = await createCreditNote(id, reason)
    setLoading(null)
    if (result?.error) {
      toast.error(result.error)
    } else {
      toast.success(`Avoir ${result.number} émis.`)
      router.refresh()
    }
  }

  if (kind === "CREDIT_NOTE" || status === "CANCELLED") return <span className="text-xs text-slate-400">—</span>

  const btn = "flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors"
  return (
    <div className="flex items-center justify-end gap-1">
      {status === "DRAFT" && (
        <button onClick={() => set("SENT")} disabled={loading !== null} className={`${btn} text-blue-600 hover:bg-blue-50`} title="Émettre (envoyer)">
          {loading === "SENT" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
        </button>
      )}
      {status === "SENT" && (
        <button onClick={() => set("PAID")} disabled={loading !== null} className={`${btn} text-green-600 hover:bg-green-50`} title="Marquer payée">
          {loading === "PAID" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
        </button>
      )}
      {status === "DRAFT" && (
        <button onClick={() => set("CANCELLED")} disabled={loading !== null} className={`${btn} text-slate-400 hover:text-red-500`} title="Abandonner le brouillon">
          {loading === "CANCELLED" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
        </button>
      )}
      {(status === "SENT" || status === "PAID") && (
        <button onClick={credit} disabled={loading !== null} className={`${btn} text-amber-600 hover:bg-amber-50`} title="Émettre un avoir">
          {loading === "CREDIT" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
        </button>
      )}
    </div>
  )
}
