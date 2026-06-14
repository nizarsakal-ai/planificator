"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { toggleCompanyActive, deleteCompany } from "@/lib/actions/super-admin.actions"
import { Trash2, PowerOff, Power } from "lucide-react"

interface Props {
  companyId:   string
  isActive:    boolean
  companyName: string
}

export function CompanyActions({ companyId, isActive, companyName }: Props) {
  const router  = useRouter()
  const [loadingToggle, setLoadingToggle] = useState(false)
  const [loadingDelete, setLoadingDelete] = useState(false)

  async function handleToggle() {
    setLoadingToggle(true)
    try {
      await toggleCompanyActive(companyId)
      toast.success(isActive ? "Compte désactivé" : "Compte activé")
      router.refresh()
    } catch {
      toast.error("Erreur lors de la mise à jour")
    } finally {
      setLoadingToggle(false)
    }
  }

  async function handleDelete() {
    const confirmed = window.confirm(
      `Supprimer "${companyName}" ?\n\nCette action est irréversible. Tous les utilisateurs, chantiers, équipes et logements seront définitivement supprimés.`
    )
    if (!confirmed) return

    setLoadingDelete(true)
    try {
      await deleteCompany(companyId)
      toast.success(`Entreprise "${companyName}" supprimée`)
      router.refresh()
    } catch {
      toast.error("Erreur lors de la suppression")
    } finally {
      setLoadingDelete(false)
    }
  }

  return (
    <div className="flex items-center gap-2 shrink-0">
      {/* Désactiver / Activer */}
      <Button
        variant="outline"
        size="sm"
        onClick={handleToggle}
        disabled={loadingToggle}
        className={isActive
          ? "text-slate-600 hover:text-orange-600 hover:border-orange-300"
          : "text-green-600 hover:text-green-700 hover:border-green-300"
        }
      >
        {isActive ? (
          <><PowerOff className="h-3.5 w-3.5 mr-1.5" />Désactiver</>
        ) : (
          <><Power className="h-3.5 w-3.5 mr-1.5" />Activer</>
        )}
      </Button>

      {/* Supprimer */}
      <Button
        variant="destructive"
        size="sm"
        onClick={handleDelete}
        disabled={loadingDelete}
      >
        <Trash2 className="h-3.5 w-3.5 mr-1.5" />
        Supprimer
      </Button>
    </div>
  )
}
