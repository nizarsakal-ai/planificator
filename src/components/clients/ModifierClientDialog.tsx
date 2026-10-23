"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { ClientForm, type EditableClient } from "./ClientForm"

export function ModifierClientDialog({ client }: { client: EditableClient }) {
  const [open, setOpen] = useState(false)
  const router = useRouter()
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" aria-label={`Modifier ${client.name}`}>
          <Pencil className="mr-1 h-4 w-4" />Modifier
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Modifier le client</DialogTitle>
          <DialogDescription>Mettez à jour les informations de {client.name}.</DialogDescription>
        </DialogHeader>
        {open && <ClientForm client={client} onSuccess={() => { setOpen(false); router.refresh() }} />}
      </DialogContent>
    </Dialog>
  )
}
