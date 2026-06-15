"use client"

import { useTransition } from "react"
import { toast } from "sonner"
import { X, Loader2 } from "lucide-react"
import { removeEmployeeFromBlock } from "@/lib/actions/chantier.actions"

export function RemoveEmployeeFromBlockButton({
  worksiteId,
  teamId,
  startDate,
  endDate,
  employeeId,
  employeeName,
}: {
  worksiteId: string
  teamId: string
  startDate: string
  endDate: string
  employeeId: string
  employeeName: string
}) {
  const [isPending, startTransition] = useTransition()

  const handleClick = () => {
    if (!confirm(`Retirer ${employeeName} de cette affectation ?`)) return
    startTransition(async () => {
      const result = await removeEmployeeFromBlock(worksiteId, teamId, startDate, endDate, employeeId)
      if (result?.error) toast.error(result.error)
      else toast.success(`${employeeName} retiré de l'affectation`)
    })
  }

  return (
    <button
      onClick={handleClick}
      disabled={isPending}
      className="ml-0.5 text-slate-400 hover:text-red-500 transition-colors"
      title={`Retirer ${employeeName}`}
    >
      {isPending ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <X className="h-2.5 w-2.5" />}
    </button>
  )
}
