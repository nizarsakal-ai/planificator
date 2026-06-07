"use client"

import { useState } from "react"
import { Trash2, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { deleteLogement } from "@/lib/actions/logement.actions"

export function LogementDeleteButton({ id }: { id: string }) {
  const router = useRouter()
  const [confirm, setConfirm] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleClick() {
    if (!confirm) { setConfirm(true); return }
    setLoading(true)
    const result = await deleteLogement(id)
    setLoading(false)
    if (result?.error) {
      toast.error(result.error)
      setConfirm(false)
    } else {
      toast.success("Logement supprimé.")
      router.refresh()
    }
  }

  return (
    <button
      onClick={handleClick}
      onBlur={() => setTimeout(() => setConfirm(false), 200)}
      className={`flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors ${
        confirm
          ? "bg-red-100 text-red-700 hover:bg-red-200"
          : "text-slate-400 hover:text-red-500"
      }`}
      title={confirm ? "Cliquer à nouveau pour confirmer" : "Supprimer"}
    >
      {loading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Trash2 className="h-3.5 w-3.5" />
      )}
      {confirm && "Confirmer ?"}
    </button>
  )
}
