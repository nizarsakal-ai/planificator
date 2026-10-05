"use client"

import { UserX, UserCheck, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useEmployeActions } from "@/components/employes/useEmployeActions"

interface EmployeActionsProps {
  employeeId: string
  active: boolean
}

export function EmployeActions({ employeeId, active }: EmployeActionsProps) {
  const { loading, toggleActive, remove } = useEmployeActions(employeeId, active)

  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="ghost"
        size="sm"
        onClick={toggleActive}
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
        onClick={remove}
        disabled={loading}
        className="text-red-600 hover:text-red-800 hover:bg-red-50"
      >
        <Trash2 className="h-4 w-4 mr-1" /> Supprimer
      </Button>
    </div>
  )
}
