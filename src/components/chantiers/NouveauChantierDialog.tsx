"use client"

import { useState } from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { ChantierForm } from "./ChantierForm"

interface Client {
  id: string
  name: string
}

interface NouveauChantierDialogProps {
  clients: Client[]
  initialClientId?: string
  onCreated?: (worksiteId: string) => void
}

export function NouveauChantierDialog({ clients, initialClientId, onCreated }: NouveauChantierDialogProps) {
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" className="bg-[#0f3460] hover:bg-[#0a2540]">
          <Plus className="h-4 w-4 mr-2" />
          Nouveau chantier
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Créer un chantier</DialogTitle>
        </DialogHeader>
        <ChantierForm clients={clients} initialClientId={initialClientId} onSuccess={(worksiteId) => {
          setOpen(false)
          onCreated?.(worksiteId)
        }} />
      </DialogContent>
    </Dialog>
  )
}
