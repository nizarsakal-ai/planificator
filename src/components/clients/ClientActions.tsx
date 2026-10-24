"use client"

import { Fragment, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, MoreHorizontal, Pencil, Trash2, UserCheck, UserX } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ClientForm, type EditableClient } from "@/components/clients/ClientForm"
import { ClientLinkedPartnersPanel } from "@/components/clients/ClientLinkedPartnersPanel"
import { deleteClient, toggleClientActive } from "@/lib/actions/client.actions"
import { getClientMenuActions, type ClientMenuAction } from "@/lib/clients/client-actions-view"

export type ClientActionsClient = EditableClient & { active: boolean }

interface ClientActionsProps {
  client: ClientActionsClient
  /** Calculé côté serveur (page) avec `canDeleteClient(role)` : ADMIN / SUPER_ADMIN. La garde réelle reste `deleteClient`. */
  canDelete: boolean
}

const MENU_ITEMS: Record<ClientMenuAction, { label: string; Icon: typeof Pencil }> = {
  edit: { label: "Modifier", Icon: Pencil },
  deactivate: { label: "Désactiver", Icon: UserX },
  reactivate: { label: "Réactiver", Icon: UserCheck },
  delete: { label: "Supprimer…", Icon: Trash2 },
}

/** Message affiché quand l'action serveur lève (session expirée, droit refusé, panne) : le détail n'est pas exposé au navigateur. */
const GENERIC_ERROR = "Action impossible. Veuillez réessayer."

/**
 * Menu « ⋯ » d'une carte client : Modifier / Désactiver-Réactiver / Supprimer.
 *  - Modifier ouvre le formulaire existant (ClientForm → updateClient).
 *  - Désactiver/Réactiver appelle toggleClientActive (réversible, sans confirmation).
 *  - Supprimer ouvre une confirmation ; deleteClient n'est appelé qu'après confirmation.
 * Un seul appel serveur à la fois : `busy` (ref, synchrone) bloque les doubles clics,
 * `pending` (state) pilote l'affichage. Les erreurs `{ error }` sont affichées, les exceptions aussi (message générique).
 */
export function ClientActions({ client, canDelete }: ClientActionsProps) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  // Refus pour partenaire(s) lié(s) : le dialogue affiche le panneau de réaffectation (recherche par id, jamais par nom).
  const [showPartners, setShowPartners] = useState(false)
  // Appel serveur du panneau partenaires en vol : verrouille le pied du dialogue et sa fermeture comme `pending`.
  const [partnersBusy, setPartnersBusy] = useState(false)
  const dialogLocked = pending || partnersBusy
  const busy = useRef(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const actions = getClientMenuActions(client.active, canDelete)

  /** Exécute une action serveur en garantissant qu'une seule est en vol. */
  const runOnce = async (fn: () => Promise<void>) => {
    if (busy.current) return
    busy.current = true
    setPending(true)
    try {
      await fn()
    } finally {
      busy.current = false
      setPending(false)
    }
  }

  const handleToggle = () =>
    runOnce(async () => {
      try {
        const result = await toggleClientActive(client.id, !client.active)
        if (result?.error) {
          toast.error(result.error)
          return
        }
        toast.success(client.active ? "Client désactivé." : "Client réactivé.")
        router.refresh()
      } catch {
        toast.error(GENERIC_ERROR)
      }
    })

  const handleDelete = () =>
    runOnce(async () => {
      setDeleteError(null)
      try {
        const result = await deleteClient(client.id)
        if (result?.error) {
          // Refus métier (relations liées, client introuvable, course) : reste dans le dialogue pour être lu.
          setDeleteError(result.error)
          if (/partenaire/.test(result.error)) setShowPartners(true)
          return
        }
        setDeleteOpen(false)
        toast.success(`Client « ${client.name} » supprimé.`)
        router.refresh()
      } catch {
        setDeleteError(GENERIC_ERROR)
      }
    })

  const openDelete = () => {
    setDeleteError(null)
    setShowPartners(false)
    setDeleteOpen(true)
  }

  const onDeleteOpenChange = (open: boolean) => {
    if (!open && dialogLocked) return // pas de fermeture pendant un appel serveur (suppression ou panneau)
    setDeleteOpen(open)
    if (!open) {
      setDeleteError(null)
      setShowPartners(false)
      setPartnersBusy(false)
    }
  }

  const returnFocusToTrigger = (e: Event) => {
    e.preventDefault()
    triggerRef.current?.focus()
  }

  return (
    <>
      {/* modal={false} : évite le verrouillage du body quand un item ouvre un Dialog (Radix). */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          ref={triggerRef}
          disabled={pending}
          aria-label={`Actions pour ${client.name}`}
          className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 ring-offset-background transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          {actions.map((action) => {
            const { label, Icon } = MENU_ITEMS[action]
            const content = (
              <>
                <Icon className="h-4 w-4" />
                {label}
              </>
            )
            if (action === "edit") {
              return (
                <DropdownMenuItem key={action} onSelect={() => setEditOpen(true)}>
                  {content}
                </DropdownMenuItem>
              )
            }
            if (action === "delete") {
              return (
                <Fragment key={action}>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={openDelete} className="text-red-600 focus:bg-red-50 focus:text-red-700">
                    {content}
                  </DropdownMenuItem>
                </Fragment>
              )
            }
            return (
              <DropdownMenuItem key={action} onSelect={handleToggle}>
                {content}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Modifier : formulaire existant (créé par #85), désormais ouvert depuis le menu. */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto" onCloseAutoFocus={returnFocusToTrigger}>
          <DialogHeader>
            <DialogTitle>Modifier le client</DialogTitle>
            <DialogDescription>Mettez à jour les informations de {client.name}.</DialogDescription>
          </DialogHeader>
          {editOpen && (
            <ClientForm
              client={client}
              onSuccess={() => {
                setEditOpen(false)
                router.refresh()
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Supprimer : confirmation explicite ; le dialogue n'existe pas pour les rôles sans droit. */}
      {canDelete && (
        <Dialog open={deleteOpen} onOpenChange={onDeleteOpenChange}>
          <DialogContent className="sm:max-w-md" onCloseAutoFocus={returnFocusToTrigger}>
            <DialogHeader>
              <DialogTitle>Supprimer le client</DialogTitle>
              <DialogDescription>
                Supprimer définitivement « {client.name} »{client.email ? ` (${client.email})` : ""} — fiche …{client.id.slice(-6)} ?
                Cette action est irréversible. Un client lié à des chantiers,
                devis, factures, partenaires ou à un accès portail ne peut pas être supprimé : désactivez-le plutôt.
              </DialogDescription>
            </DialogHeader>
            {deleteError && (
              <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {deleteError}
              </p>
            )}
            {showPartners && (
              <ClientLinkedPartnersPanel
                clientId={client.id}
                disabled={pending}
                onBusyChange={setPartnersBusy}
                onChange={(remaining) => {
                  if (remaining === 0) setDeleteError("Plus aucun partenaire lié : vous pouvez relancer la suppression.")
                }}
              />
            )}
            <DialogFooter className="gap-2 sm:gap-0">
              <Button type="button" variant="outline" onClick={() => onDeleteOpenChange(false)} disabled={dialogLocked}>
                Annuler
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={handleDelete}
                disabled={dialogLocked}
                aria-busy={pending}
              >
                {pending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Suppression…
                  </>
                ) : (
                  <>
                    <Trash2 className="mr-2 h-4 w-4" /> Supprimer
                  </>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
