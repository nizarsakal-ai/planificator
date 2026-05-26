"use client"

import { useState } from "react"
import { toast } from "sonner"
import { UserX, UserCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { toggleClientActive } from "@/lib/actions/client.actions"
import { useRouter } from "next/navigation"

interface ClientActionsProps {
  clientId: string
  active: boolean
}

export function ClientActions({ clientId, active }: ClientActionsProps) {
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const handleToggle = async () => {
    setLoading(true)
    const result = await toggleClientActive(clientId, !active)
    setLoading(false)

    if (result?.error) {
      toast.error(result.error)
    } else {
      toast.success(active ? "Client désactivé." : "Client réactivé.")
      router.refresh()
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleToggle}
      disabled={loading}
      className={
        active
          ? "text-red-500 hover:text-red-700 hover:bg-red-50"
          : "text-green-600 hover:text-green-800 hover:bg-green-50"
      }
    >
      {active ? (
        <><UserX className="h-4 w-4 mr-1" /> Désactiver</>
      ) : (
        <><UserCheck className="h-4 w-4 mr-1" /> Réactiver</>
      )}
    </Button>
  )
}
