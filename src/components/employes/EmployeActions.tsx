"use client"

import { useState } from "react"
import { toast } from "sonner"
import { UserX, UserCheck, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { toggleEmployeActive, deleteEmploye } from "@/lib/actions/employe.actions"

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
      toast.success(active ? "Employe desactive." : "Employe reactive.")
    }
  }

  const handleDelete = async () => {
    if (!confirm("Supprimer definitivement cet employe ? Cette action est irreversible.")) return
    setLoading(true)
    const result = await deleteEmploye(employeeId)
    setLoading(false)
    if (result?.error) {
      toast.error(result.error)
    } else {
      toast.success("Employe supprime.")
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="ghost"
        size="sm"
        onClick={handleToggle}
        disabled={loading}
        className={active ? "text-red-500 hover:text-red-700 hover:bg-red-50" : "text-green-600 hover:text-green-800 hover:bg-green-50"}
      >
        {active ? (
          <><UserX className="h-4 w-4 mr-1" /> Desactiver</>
        ) : (
          <><UserCheck className="h-4 w-4 mr-1" /> Reactiver</>
        )}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={handleDelete}
        disabled={loading}
        className="text-red-600 hover:text-red-800 hover:bg-red-50"
      >
        <Trash2 className="h-4 w-4 mr-1" /> Supprimer
      </Button>
    </div>
  )
}
