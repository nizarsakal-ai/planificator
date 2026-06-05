"use client"

import { useTransition } from "react"
import { toast } from "sonner"
import { X, Loader2 } from "lucide-react"
import { removeEmployeeFromAssignment } from "@/lib/actions/chantier.actions"

export function RemoveEmployeeButton({
  assignmentId,
  employeeId,
  employeeName,
}: {
  assignmentId: string
  employeeId: string
  employeeName: string
}) {
  const [isPending, startTransition] = useTransition()

  const handleClick = () => {
    if (!confirm(`Retirer ${employeeName} de cette affectation ?`)) return
    startTransition(async () => {
      const result = await removeEmployeeFromAssignment(assignmentId, employeeId)
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
