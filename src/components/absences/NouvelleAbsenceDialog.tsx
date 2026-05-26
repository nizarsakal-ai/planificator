"use client"

import { useState } from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { AbsenceForm } from "./AbsenceForm"

interface Employee { id: string; firstName: string; lastName: string }

export function NouvelleAbsenceDialog({ employees }: { employees: Employee[] }) {
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="bg-[#0f3460] hover:bg-[#0a2540]">
          <Plus className="h-4 w-4 mr-2" /> Nouvelle absence
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Déclarer une absence</DialogTitle>
        </DialogHeader>
        <AbsenceForm employees={employees} onSuccess={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  )
}
