"use client"

import { Fragment, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Archive, ArchiveRestore, Eye, MoreHorizontal, Pencil, Truck, Users } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { TruckSelector } from "@/components/equipes/TruckSelector"
import { archiveEquipe, unarchiveEquipe } from "@/lib/actions/equipe.actions"
import { getEquipeMenuActions, type EquipeMenuAction, type EquipeViewItem } from "@/lib/equipes/equipes-view"

/** Forme attendue par TruckSelector (inchangé). */
export interface EquipeTruckOption {
  id: string
  matricule: string
  marque?: string | null
  chauffeurId?: string | null
  teamId: string | null
  teamName?: string | null
}

/** Création / modification / membres : écrans existants de /equipes/[id]. */
const MENU_ITEMS: Record<EquipeMenuAction, { label: string; Icon: typeof Eye }> = {
  view: { label: "Voir l'équipe", Icon: Eye },
  edit: { label: "Modifier", Icon: Pencil },
  members: { label: "Gérer les membres", Icon: Users },
  vehicle: { label: "Gérer le véhicule", Icon: Truck },
  archive: { label: "Archiver", Icon: Archive },
  restore: { label: "Restaurer", Icon: ArchiveRestore },
}

interface EquipeActionsMenuProps {
  team: EquipeViewItem
  trucks: EquipeTruckOption[]
  /** Calculé côté serveur avec la même liste de rôles que requireAdmin / PATCH-POST /api/trucks. */
  canManage: boolean
}

/**
 * Actions secondaires d'une équipe. Uniquement des mutations existantes :
 * archiveEquipe / unarchiveEquipe, TruckSelector (PATCH/POST /api/trucks) ; le reste renvoie vers /equipes/[id].
 * Pas de suppression, pas d'affectation de chantier.
 */
export function EquipeActionsMenu({ team, trucks, canManage }: EquipeActionsMenuProps) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [truckOpen, setTruckOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const detailHref = `/equipes/${team.id}`
  const actions = getEquipeMenuActions(team.active, canManage)

  const toggleArchive = async () => {
    if (!confirm(team.active ? "Archiver cette équipe ?" : "Restaurer cette équipe ?")) return
    setLoading(true)
    try {
      const result = team.active ? await archiveEquipe(team.id) : await unarchiveEquipe(team.id)
      if (result?.error) toast.error(result.error)
      else {
        toast.success(team.active ? "Équipe archivée." : "Équipe restaurée.")
        router.refresh()
      }
    } catch {
      toast.error("Action impossible.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      {/* modal={false} : évite le verrouillage du body quand l'item ouvre un Dialog (Radix). */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          ref={triggerRef}
          disabled={loading}
          aria-label={`Actions pour ${team.name}`}
          className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 ring-offset-background transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
        >
          <MoreHorizontal className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {actions.map((action) => {
            const { label, Icon } = MENU_ITEMS[action]
            const content = (
              <>
                <Icon className="h-4 w-4" />
                {label}
              </>
            )
            if (action === "archive" || action === "restore") {
              return (
                <Fragment key={action}>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={toggleArchive}>{content}</DropdownMenuItem>
                </Fragment>
              )
            }
            if (action === "vehicle") {
              return (
                <DropdownMenuItem key={action} onSelect={() => setTruckOpen(true)}>
                  {content}
                </DropdownMenuItem>
              )
            }
            return (
              <DropdownMenuItem key={action} asChild>
                <Link href={detailHref}>{content}</Link>
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {actions.includes("vehicle") && (
        <Dialog open={truckOpen} onOpenChange={setTruckOpen}>
          <DialogContent
            className="sm:max-w-md"
            // Sans DialogTrigger : on rend explicitement le focus au bouton « ••• ».
            onCloseAutoFocus={(e) => {
              e.preventDefault()
              triggerRef.current?.focus()
            }}
          >
            <DialogHeader>
              <DialogTitle>Véhicule — {team.name}</DialogTitle>
              <DialogDescription>Affectez un véhicule existant ou ajoutez-en un nouveau.</DialogDescription>
            </DialogHeader>
            <TruckSelector
              teamId={team.id}
              currentTruck={
                team.truck ? (trucks.find((t) => t.id === team.truck!.id) ?? { ...team.truck, teamId: team.id }) : null
              }
              allTrucks={trucks}
              members={team.members.map((m) => ({ id: m.id, name: `${m.firstName} ${m.lastName}` }))}
            />
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
