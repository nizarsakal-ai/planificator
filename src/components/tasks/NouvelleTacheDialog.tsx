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
import { TaskForm, type TaskEmployeeOption, type TaskWorksiteOption } from "./TaskForm"

interface NouvelleTacheDialogProps {
  employees: TaskEmployeeOption[]
  worksites: TaskWorksiteOption[]
}

export function NouvelleTacheDialog({ employees, worksites }: NouvelleTacheDialogProps) {
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="bg-[#0f3460] hover:bg-[#0a2540]">
          <Plus className="h-4 w-4 mr-2" />
          Nouvelle tâche
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Créer une tâche</DialogTitle>
        </DialogHeader>
        <TaskForm
          employees={employees}
          worksites={worksites}
          onSuccess={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
