"use client"

import { useState } from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ClientForm } from "./ClientForm"
import { useRouter } from "next/navigation"

export function NouveauClientDialog() {
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
        Nouveau client
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 p-6 z-10 max-h-[90vh] overflow-y-auto">
            <div className="mb-5">
              <h2 className="text-lg font-semibold text-slate-900">Nouveau client</h2>
              <p className="text-sm text-slate-500 mt-1">
                Ajoutez les informations du client.
              </p>
            </div>
            <ClientForm onSuccess={handleSuccess} />
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
