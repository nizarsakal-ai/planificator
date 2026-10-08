"use client"

import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  TASK_STATUSES,
  TASK_PRIORITIES,
  TASK_STATUS_LABELS,
  TASK_PRIORITY_LABELS,
  TITLE_MAX,
  DESCRIPTION_MAX,
} from "@/lib/tasks/task.schema"
import { createTask } from "@/lib/actions/task.actions"
import { submitTaskForm } from "@/lib/tasks/task-form.submit"

export interface TaskEmployeeOption {
  id: string
  firstName: string
  lastName: string
}

export interface TaskWorksiteOption {
  id: string
  name: string
}

interface TaskFormProps {
  employees: TaskEmployeeOption[]
  worksites: TaskWorksiteOption[]
  onSuccess: () => void
}

// Validation client (légère) — la validation autoritaire reste côté serveur.
const taskFormSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Le titre est requis")
    .max(TITLE_MAX, `Le titre ne peut pas dépasser ${TITLE_MAX} caractères`),
  description: z
    .string()
    .max(DESCRIPTION_MAX, `La description ne peut pas dépasser ${DESCRIPTION_MAX} caractères`)
    .optional(),
  status: z.enum(TASK_STATUSES),
  priority: z.enum(TASK_PRIORITIES),
  dueDate: z.string().optional(),
  assigneeId: z.string().optional(),
  worksiteId: z.string().optional(),
})

type TaskFormInput = z.infer<typeof taskFormSchema>

export function TaskForm({ employees, worksites, onSuccess }: TaskFormProps) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
  } = useForm<TaskFormInput>({
    resolver: zodResolver(taskFormSchema),
    defaultValues: { status: "TODO", priority: "MEDIUM" },
  })

  const onSubmit = (data: TaskFormInput) =>
    submitTaskForm(data, {
      createTask,
      notifySuccess: (message) => toast.success(message),
      notifyError: (message) => toast.error(message),
      reset,
      onSuccess,
    })

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      {/* Titre */}
      <div className="space-y-1.5">
        <Label htmlFor="title">Titre *</Label>
        <Input
          id="title"
          placeholder="Préparer le devis, commander le matériel..."
          {...register("title")}
          className={errors.title ? "border-red-400" : ""}
        />
        {errors.title && <p className="text-xs text-red-500">{errors.title.message}</p>}
      </div>

      {/* Statut + Priorité */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="status">Statut</Label>
          <select
            id="status"
            {...register("status")}
            className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>{TASK_STATUS_LABELS[s]}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="priority">Priorité</Label>
          <select
            id="priority"
            {...register("priority")}
            className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            {TASK_PRIORITIES.map((p) => (
              <option key={p} value={p}>{TASK_PRIORITY_LABELS[p]}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Échéance */}
      <div className="space-y-1.5">
        <Label htmlFor="dueDate">Échéance</Label>
        <Input id="dueDate" type="date" {...register("dueDate")} />
      </div>

      {/* Employé assigné */}
      <div className="space-y-1.5">
        <Label htmlFor="assigneeId">Employé assigné</Label>
        <select
          id="assigneeId"
          {...register("assigneeId")}
          className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">Aucun</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>
          ))}
        </select>
      </div>

      {/* Chantier */}
      <div className="space-y-1.5">
        <Label htmlFor="worksiteId">Chantier</Label>
        <select
          id="worksiteId"
          {...register("worksiteId")}
          className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">Aucun</option>
          {worksites.map((w) => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </select>
      </div>

      {/* Description */}
      <div className="space-y-1.5">
        <Label htmlFor="description">Description</Label>
        <textarea
          id="description"
          rows={5}
          placeholder="Détails de la tâche, instructions particulières..."
          {...register("description")}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-ring min-h-[100px]"
        />
        {errors.description && <p className="text-xs text-red-500">{errors.description.message}</p>}
      </div>

      {/* Bouton */}
      <div className="flex justify-end pt-2">
        <Button type="submit" disabled={isSubmitting} className="bg-[#0f3460] hover:bg-[#0a2540]">
          {isSubmitting ? (
            <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Création...</>
          ) : (
            "Créer la tâche"
          )}
        </Button>
      </div>
    </form>
  )
}
