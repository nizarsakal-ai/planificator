"use client"

import { useState } from "react"
import { toast } from "sonner"
import { toggleEmployeActive, deleteEmploye } from "@/lib/actions/employe.actions"

/**
 * Actions employé existantes (server actions inchangées : RBAC + scope companyId côté serveur).
 * Partagé par les boutons de la fiche et le menu « ⋯ » de la liste.
 */
export function useEmployeActions(employeeId: string, active: boolean) {
  const [loading, setLoading] = useState(false)

  const toggleActive = async () => {
    setLoading(true)
    const result = await toggleEmployeActive(employeeId, !active)
    setLoading(false)
    if (result?.error) {
      toast.error(result.error)
    } else {
      toast.success(active ? "Employe desactive." : "Employe reactive.")
    }
  }

  const remove = async () => {
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

  return { loading, toggleActive, remove }
}
