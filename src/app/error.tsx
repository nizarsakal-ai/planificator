"use client"

import { useEffect } from "react"
import { Button } from "@/components/ui/button"
import { AlertTriangle } from "lucide-react"

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="text-center space-y-6 max-w-md">
        <div className="w-14 h-14 rounded-2xl bg-red-100 flex items-center justify-center mx-auto">
          <AlertTriangle className="h-7 w-7 text-red-500" />
        </div>
        <div>
          <h2 className="text-xl font-semibold text-slate-800">Une erreur est survenue</h2>
          <p className="text-slate-500 text-sm mt-2">
            Quelque chose s&apos;est mal passé. Essayez de recharger la page.
          </p>
        </div>
        <div className="flex items-center justify-center gap-3">
          <Button variant="outline" onClick={() => window.location.href = "/dashboard"}>
            Dashboard
          </Button>
          <Button className="bg-[#0f3460] hover:bg-[#0a2540]" onClick={reset}>
            Réessayer
          </Button>
        </div>
      </div>
    </div>
  )
}
