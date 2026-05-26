"use client"

import { useState } from "react"
import { toast } from "sonner"
import { UserMinus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { removeMembre } from "@/lib/actions/equipe.actions"
import { useRouter } from "next/navigation"

interface MembreActionsProps {
  teamId: string
  employeeId: string
  isLeader: boolean
}

export function MembreActions({ teamId, employeeId, isLeader }: MembreActionsProps) {
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  if (isLeader) {
    return <span className="text-xs text-blue-600 font-medium px-2">Chef</span>
  }

  const handleRemove = async () => {
    if (!confirm("Retirer ce membre de l'équipe ?")) return
    setLoading(true)
    const result = await removeMembre(teamId, employeeId)
    setLoading(false)

    if (result?.error) {
      toast.error(result.error)
    } else {
      toast.success("Membre retiré.")
      router.refresh()
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleRemove}
      disabled={loading}
      className="text-red-400 hover:text-red-600 hover:bg-red-50 h-7 px-2"
    >
      <UserMinus className="h-3.5 w-3.5" />
    </Button>
  )
}
