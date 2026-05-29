"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { UserPlus, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { addMembre } from "@/lib/actions/equipe.actions"

interface Employee {
  id: string
  firstName: string
  lastName: string
  jobTitle: string | null
}

interface Props {
  teamId: string
  available: Employee[]
}

export function AjouterMembreDialog({ teamId, available }: Props) {
  const router = useRouter()
  const [open, setOpen]       = useState(false)
  const [loading, setLoading] = useState<string | null>(null)

  async function handleAdd(employeeId: string) {
    setLoading(employeeId)
    const result = await addMembre(teamId, employeeId)
    setLoading(null)
    if (result?.error) { toast.error(result.error); return }
    toast.success("Membre ajouté.")
    setOpen(false)
    router.refresh()
  }

  if (available.length === 0) return null

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        className="h-8 text-xs gap-1.5"
      >
        <UserPlus className="h-3.5 w-3.5" />
        Ajouter un membre
      </Button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1 z-20 bg-white border border-slate-200 rounded-xl shadow-lg w-64 overflow-hidden">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide px-3 py-2 border-b">
              Ajouter un membre
            </p>
            <div className="max-h-56 overflow-y-auto divide-y divide-slate-50">
              {available.map((emp) => (
                <button
                  key={emp.id}
                  onClick={() => handleAdd(emp.id)}
                  disabled={loading === emp.id}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-slate-50 text-left transition-colors"
                >
                  {loading === emp.id
                    ? <Loader2 className="h-4 w-4 animate-spin text-slate-400 shrink-0" />
                    : (
                      <span className="w-7 h-7 rounded-full bg-[#0f3460] text-white text-xs font-bold flex items-center justify-center shrink-0">
                        {emp.firstName[0]}{emp.lastName[0]}
                      </span>
                    )
                  }
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-800 truncate">
                      {emp.firstName} {emp.lastName}
                    </p>
                    {emp.jobTitle && (
                      <p className="text-xs text-slate-400 truncate">{emp.jobTitle}</p>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
