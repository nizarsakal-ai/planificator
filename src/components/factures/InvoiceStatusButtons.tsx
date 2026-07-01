"use client"

import { useState } from "react"
import { Loader2, Send, CheckCircle2, XCircle } from "lucide-react"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { updateInvoiceStatus } from "@/lib/actions/invoice.actions"

type Status = "DRAFT" | "SENT" | "PAID" | "CANCELLED"

export function InvoiceStatusButtons({ id, status }: { id: string; status: Status }) {
  const router = useRouter()
  const [loading, setLoading] = useState<Status | null>(null)

  async function set(next: "SENT" | "PAID" | "CANCELLED") {
    setLoading(next)
    const result = await updateInvoiceStatus(id, next)
    setLoading(null)
    if (result?.error) {
      toast.error(result.error)
    } else {
      toast.success(
        next === "SENT" ? "Facture marquée envoyée." :
        next === "PAID" ? "Facture marquée payée." :
        "Facture annulée."
      )
      router.refresh()
    }
  }

  if (status === "CANCELLED") return <span className="text-xs text-slate-400">—</span>

  return (
    <div className="flex items-center justify-end gap-1">
      {status === "DRAFT" && (
        <button
          onClick={() => set("SENT")}
          disabled={loading !== null}
          className="flex items-center gap-1 text-xs px-2 py-1 rounded text-blue-600 hover:bg-blue-50 transition-colors"
          title="Marquer envoyée"
        >
          {loading === "SENT" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
        </button>
      )}
      {status === "SENT" && (
        <button
          onClick={() => set("PAID")}
          disabled={loading !== null}
          className="flex items-center gap-1 text-xs px-2 py-1 rounded text-green-600 hover:bg-green-50 transition-colors"
          title="Marquer payée"
        >
          {loading === "PAID" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
        </button>
      )}
      {status !== "PAID" && (
        <button
          onClick={() => set("CANCELLED")}
          disabled={loading !== null}
          className="flex items-center gap-1 text-xs px-2 py-1 rounded text-slate-400 hover:text-red-500 transition-colors"
          title="Annuler"
        >
          {loading === "CANCELLED" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
        </button>
      )}
    </div>
  )
}
