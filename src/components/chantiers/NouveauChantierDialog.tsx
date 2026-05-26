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
}

export function NouveauChantierDialog({ clients }: NouveauChantierDialogProps) {
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="bg-[#0f3460] hover:bg-[#0a2540]">
          <Plus className="h-4 w-4 mr-2" />
          Nouveau chantier
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Créer un chantier</DialogTitle>
        </DialogHeader>
        <ChantierForm clients={clients} onSuccess={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  )
}
