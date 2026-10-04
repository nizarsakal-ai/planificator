"use client"

import Link from "next/link"
import { Archive, ArchiveRestore, Eye, MoreHorizontal, Trash2 } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useEmployeActions } from "@/components/employes/useEmployeActions"

interface EmployeActionsMenuProps {
  employeeId: string
  fullName: string
  active: boolean
}

/** Actions secondaires regroupées — la suppression définitive reste en dernier et confirmée. */
export function EmployeActionsMenu({ employeeId, fullName, active }: EmployeActionsMenuProps) {
  const { loading, toggleActive, remove } = useEmployeActions(employeeId, active)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={loading}
        aria-label={`Actions pour ${fullName}`}
        className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 ring-offset-background transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
      >
        <MoreHorizontal className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem asChild>
          <Link href={`/employes/${employeeId}`}>
            <Eye className="h-4 w-4" />
            Voir la fiche
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={toggleActive}>
          {active ? (
            <>
              <Archive className="h-4 w-4" />
              Archiver (désactiver)
            </>
          ) : (
            <>
              <ArchiveRestore className="h-4 w-4" />
              Réactiver
            </>
          )}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={remove}
          className="text-red-600 focus:bg-red-50 focus:text-red-700"
        >
          <Trash2 className="h-4 w-4" />
          Supprimer définitivement…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
