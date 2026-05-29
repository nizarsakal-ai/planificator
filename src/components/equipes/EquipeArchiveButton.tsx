"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Archive, ArchiveRestore } from "lucide-react"
import { Button } from "@/components/ui/button"
import { archiveEquipe, unarchiveEquipe } from "@/lib/actions/equipe.actions"

interface Props {
  teamId: string
  active: boolean
}

export function EquipeArchiveButton({ teamId, active }: Props) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function handle() {
    if (!confirm(active ? "Archiver cette équipe ?" : "Réactiver cette équipe ?")) return
    setLoading(true)
    const result = active ? await archiveEquipe(teamId) : await unarchiveEquipe(teamId)
    setLoading(false)
    if (result?.error) { toast.error(result.error); return }
    toast.success(active ? "Équipe archivée." : "Équipe réactivée.")
    router.refresh()
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handle}
      disabled={loading}
      className={`h-8 text-xs gap-1.5 ${active ? "text-red-500 hover:text-red-600 hover:bg-red-50 border-red-200" : "text-green-600 hover:bg-green-50 border-green-200"}`}
    >
      {active
        ? <><Archive className="h-3.5 w-3.5" />Archiver</>
        : <><ArchiveRestore className="h-3.5 w-3.5" />Réactiver</>
      }
    </Button>
  )
}
