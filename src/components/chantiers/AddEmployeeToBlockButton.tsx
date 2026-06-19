"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import { UserPlus, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { addEmployeeToBlock } from "@/lib/actions/chantier.actions"

type Employee = { id: string; firstName: string; lastName: string }

export function AddEmployeeToBlockButton({
  worksiteId,
  teamId,
  startDate,
  endDate,
  currentEmployeeIds,
  allEmployees,
}: {
  worksiteId: string
  teamId: string
  startDate: string
  endDate: string
  currentEmployeeIds: string[]
  allEmployees: Employee[]
}) {
  const [open, setOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string>("")
  const [isPending, startTransition] = useTransition()

  const available = allEmployees.filter((e) => !currentEmployeeIds.includes(e.id))

  const handleAdd = () => {
    if (!selectedId) return
    startTransition(async () => {
      const result = await addEmployeeToBlock(worksiteId, teamId, startDate, endDate, selectedId)
      if (result?.error) {
        toast.error(result.error)
      } else {
        const emp = allEmployees.find((e) => e.id === selectedId)
        const name = emp ? `${emp.firstName} ${emp.lastName}` : "Employé"
        if (result.skipped && result.skipped > 0) {
          toast.success(`${name} ajouté (${result.skipped} jour${result.skipped > 1 ? "s" : ""} ignoré${result.skipped > 1 ? "s" : ""} — déjà affecté ailleurs)`)
        } else {
          toast.success(`${name} ajouté à l'affectation`)
        }
        setOpen(false)
        setSelectedId("")
      }
    })
  }

  if (available.length === 0) return null

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          className="ml-1 text-slate-400 hover:text-blue-500 transition-colors"
          title="Ajouter un employé à ce bloc"
        >
          <UserPlus className="h-3.5 w-3.5" />
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base">Ajouter un employé</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-slate-500 mb-3">
          L&apos;employé sera ajouté à ce bloc uniquement, sans être intégré à l&apos;équipe.
        </p>
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-900"
        >
          <option value="">Choisir un employé…</option>
          {available.map((emp) => (
            <option key={emp.id} value={emp.id}>
              {emp.firstName} {emp.lastName}
            </option>
          ))}
        </select>
        <Button onClick={handleAdd} disabled={!selectedId || isPending} className="w-full mt-3">
          {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
          Ajouter
        </Button>
      </DialogContent>
    </Dialog>
  )
}
