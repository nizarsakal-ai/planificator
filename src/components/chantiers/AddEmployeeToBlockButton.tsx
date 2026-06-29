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
type Conflict = { iso: string; date: string; worksiteName: string; teamName: string }

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
  const [conflicts, setConflicts] = useState<Conflict[]>([])
  const [isPending, startTransition] = useTransition()

  const available = allEmployees.filter((e) => !currentEmployeeIds.includes(e.id))
  const selectedName = (() => {
    const emp = allEmployees.find((e) => e.id === selectedId)
    return emp ? `${emp.firstName} ${emp.lastName}` : "Employé"
  })()

  const reset = () => {
    setOpen(false)
    setSelectedId("")
    setConflicts([])
  }

  const handleAdd = () => {
    if (!selectedId) return
    startTransition(async () => {
      const result = await addEmployeeToBlock(worksiteId, teamId, startDate, endDate, selectedId)
      if (result?.error) {
        toast.error(result.error)
        return
      }
      if (result.skipped && result.skipped > 0 && result.conflicts?.length) {
        // Conflit : on affiche OÙ l'employé est déjà affecté (lecture seule, rien n'est supprimé)
        setConflicts(result.conflicts)
        if (result.added > 0) {
          toast.success(`${selectedName} ajouté sur ${result.added} jour${result.added > 1 ? "s" : ""}.`)
        }
        return
      }
      toast.success(`${selectedName} ajouté à l'affectation`)
      reset()
    })
  }

  if (available.length === 0) return null

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : reset())}>
      <DialogTrigger asChild>
        <button
          className="ml-1 text-slate-400 hover:text-blue-500 transition-colors"
          title="Ajouter un employé à ce bloc"
        >
          <UserPlus className="h-3.5 w-3.5" />
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        {conflicts.length > 0 ? (
          <>
            <DialogHeader>
              <DialogTitle className="text-base">{selectedName} déjà affecté ailleurs</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-slate-500">
              Ce{conflicts.length > 1 ? "s" : ""} jour{conflicts.length > 1 ? "s" : ""} n&apos;
              {conflicts.length > 1 ? "ont" : "a"} pas été ajouté{conflicts.length > 1 ? "s" : ""} : {selectedName} est
              déjà affecté ici. Allez l&apos;y désaffecter, puis revenez l&apos;ajouter. Rien n&apos;a été modifié sur
              ces affectations.
            </p>
            <ul className="my-2 space-y-1 rounded-md bg-amber-50 border border-amber-100 p-2.5 text-xs text-amber-800">
              {conflicts.map((c) => (
                <li key={c.iso}>
                  <strong>{c.date}</strong> — « {c.worksiteName} » (équipe {c.teamName})
                </li>
              ))}
            </ul>
            <Button onClick={reset} className="w-full mt-1">
              J&apos;ai compris
            </Button>
          </>
        ) : (
          <>
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
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
