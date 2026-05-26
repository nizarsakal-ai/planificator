"use client"

import { useState } from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EquipeForm } from "./EquipeForm"
import { useRouter } from "next/navigation"

interface Employee {
  id: string
  firstName: string
  lastName: string
  jobTitle: string | null
}

export function NouvelleEquipeDialog({ employees }: { employees: Employee[] }) {
  const [open, setOpen] = useState(false)
  const router = useRouter()

  const handleSuccess = () => {
    setOpen(false)
    router.refresh()
  }

  return (
    <>
      <Button onClick={() => setOpen(true)} className="bg-[#0f3460] hover:bg-[#0a2540] gap-2">
        <Plus className="h-4 w-4" />
        Nouvelle équipe
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 p-6 z-10 max-h-[90vh] overflow-y-auto">
            <div className="mb-5">
              <h2 className="text-lg font-semibold text-slate-900">Nouvelle équipe</h2>
              <p className="text-sm text-slate-500 mt-1">
                Choisissez un nom, une couleur et un chef d'équipe.
              </p>
            </div>
            <EquipeForm employees={employees} onSuccess={handleSuccess} />
            <button
              onClick={() => setOpen(false)}
              className="absolute top-4 right-4 text-slate-400 hover:text-slate-600 text-xl leading-none"
            >
              ×
            </button>
          </div>
        </div>
      )}
    </>
  )
}
