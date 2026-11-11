"use client"

import { useState } from "react"
import { Plus } from "lucide-react"
import { ClientForm } from "@/components/clients/ClientForm"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { NouveauChantierDialog } from "./NouveauChantierDialog"

type ClientOption = { id: string; name: string }

export function BillingWorksiteActions({ clients, onWorksiteCreated }: {
  clients: ClientOption[]
  onWorksiteCreated: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [addedClients, setAddedClients] = useState<ClientOption[]>([])
  const options = [...clients, ...addedClients.filter((added) => !clients.some((client) => client.id === added.id))]

  return (
    <div className="flex flex-wrap gap-2">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button type="button" variant="outline" size="sm">
            <Plus className="h-4 w-4" /> Ajouter un client
          </Button>
        </DialogTrigger>
        <DialogContent className="max-h-[90vh] overflow-y-auto" aria-describedby={undefined}>
          <DialogHeader><DialogTitle>Nouveau client</DialogTitle></DialogHeader>
          <ClientForm onSuccess={(client) => {
            if (client) setAddedClients((previous) => [...previous, client])
            setOpen(false)
          }} />
        </DialogContent>
      </Dialog>
      <NouveauChantierDialog
        clients={options}
        initialClientId={addedClients.at(-1)?.id}
        onCreated={onWorksiteCreated}
      />
    </div>
  )
}
