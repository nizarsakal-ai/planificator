"use client"

import { useState } from "react"
import { toast } from "sonner"
import { UserX, UserCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { toggleEmployeActive } from "@/lib/actions/employe.actions"

interface EmployeActionsProps {
  employeeId: string
  active: boolean
}

export function EmployeActions({ employeeId, active }: EmployeActionsProps) {
  const [loading, setLoading] = useState(false)

  const handleToggle = async () => {
    setLoading(true)
    const result = await toggleEmployeActive(employeeId, !active)
    setLoading(false)

    if (result?.error) {
      toast.error(result.error)
    } else {
      toast.success(active ? "Employé désactivé." : "Employé réactivé.")
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleToggle}
      disabled={loading}
      className={active ? "text-red-500 hover:text-red-700 hover:bg-red-50" : "text-green-600 hover:text-green-800 hover:bg-green-50"}
    >
      {active ? (
        <><UserX className="h-4 w-4 mr-1" /> Désactiver</>
      ) : (
        <><UserCheck className="h-4 w-4 mr-1" /> Réactiver</>
      )}
    </Button>
  )
}
