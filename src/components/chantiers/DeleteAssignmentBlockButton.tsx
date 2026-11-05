"use client"

import { useState } from "react"
import { Trash2, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { deleteAssignmentBlock } from "@/lib/actions/chantier.actions"
import { validateBlockRange, ymdFr } from "@/lib/chantiers/assignment-range"

interface Props {
  worksiteId: string
  teamId: string
  teamName: string
  startDate: string // YYYY-MM-DD
  endDate: string   // YYYY-MM-DD
  dayCount: number
}

export function DeleteAssignmentBlockButton({
  worksiteId,
  teamId,
  teamName,
  startDate,
  endDate,
  dayCount,
}: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  // Par défaut : tout le bloc (comportement historique). Plage partielle seulement si l'utilisateur la choisit.
  const [partial, setPartial] = useState(false)
  const [from, setFrom] = useState(startDate)
  const [to, setTo] = useState(endDate)

  const range = partial ? validateBlockRange({ from: startDate, to: endDate }, { from, to }) : null
  const target = range?.ok ? range : { from: startDate, to: endDate, days: dayCount }
  const blocked = loading || (range !== null && !range.ok)

  function openDialog() {
    setPartial(false); setFrom(startDate); setTo(endDate); setOpen(true)
  }

  async function handleDelete() {
    if (blocked) return
    setLoading(true)
    const result = await deleteAssignmentBlock(worksiteId, teamId, target.from, target.to)
    setLoading(false)
    if (result?.error) {
      toast.error(result.error)
    } else {
      toast.success(partial ? "Jours d'affectation supprimés." : "Affectation supprimée.")
      setOpen(false)
      router.refresh()
    }
  }

  const days = `${target.days} jour${target.days > 1 ? "s" : ""}`

  return (
    <>
      <button
        onClick={openDialog}
        className="text-slate-300 hover:text-red-500 transition-colors"
        title="Supprimer cette affectation"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Supprimer l'affectation</DialogTitle>
          </DialogHeader>
          <label className="flex items-start gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} disabled={loading} />
            <span>Supprimer seulement une partie du bloc (du {ymdFr(startDate)} au {ymdFr(endDate)})</span>
          </label>
          {partial && (
            <div className="grid grid-cols-2 gap-2 text-sm">
              <label className="space-y-1">Du
                <input type="date" className="w-full h-8 rounded-md border border-input px-2" min={startDate} max={endDate} value={from} onChange={(e) => setFrom(e.target.value)} disabled={loading} />
              </label>
              <label className="space-y-1">Au
                <input type="date" className="w-full h-8 rounded-md border border-input px-2" min={startDate} max={endDate} value={to} onChange={(e) => setTo(e.target.value)} disabled={loading} />
              </label>
            </div>
          )}
          {range && !range.ok
            ? <p role="status" className="text-sm text-amber-800">{range.message}</p>
            : <p className="text-sm text-slate-600">
                {partial
                  ? <>Voulez-vous supprimer l'affectation de <strong>{teamName}</strong> du <strong>{ymdFr(target.from)}</strong> au <strong>{ymdFr(target.to)}</strong> ({days}) ? Les autres jours du bloc sont conservés. </>
                  : <>Voulez-vous supprimer l'affectation de <strong>{teamName}</strong> ({days}) ? </>}
                Cette action est irréversible.
              </p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={loading}>
              Annuler
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={blocked}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : partial ? `Supprimer ces ${days}` : "Supprimer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
