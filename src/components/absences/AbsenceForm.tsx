"use client"

import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createAbsenceSchema, type CreateAbsenceInput } from "@/lib/validations/absence"
import { createAbsence } from "@/lib/actions/absence.actions"

interface Employee { id: string; firstName: string; lastName: string }

const TYPE_LABELS: Record<string, string> = {
  VACATION: "Congé payé",
  SICK:     "Maladie",
  UNPAID:   "Congé sans solde",
  TRAINING: "Formation",
  OTHER:    "Autre",
}

export function AbsenceForm({ employees, onSuccess }: { employees: Employee[]; onSuccess: () => void }) {
  const today = new Date().toISOString().split("T")[0]

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
  } = useForm<CreateAbsenceInput>({
    resolver: zodResolver(createAbsenceSchema),
    defaultValues: { startDate: today, endDate: today },
  })

  const onSubmit = async (data: CreateAbsenceInput) => {
    const fd = new FormData()
    Object.entries(data).forEach(([k, v]) => { if (v) fd.append(k, String(v)) })
    const result = await createAbsence(fd)
    if (result?.error) { toast.error(result.error); return }
    toast.success("Absence enregistrée.")
    reset()
    onSuccess()
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      {/* Employé */}
      <div className="space-y-1.5">
        <Label>Employé *</Label>
        <select
          {...register("employeeId")}
          className={`w-full h-9 rounded-md border bg-background px-3 text-sm ${errors.employeeId ? "border-red-400" : "border-input"}`}
        >
          <option value="">-- Sélectionner un employé --</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>
          ))}
        </select>
        {errors.employeeId && <p className="text-xs text-red-500">{errors.employeeId.message}</p>}
      </div>

      {/* Type */}
      <div className="space-y-1.5">
        <Label>Type d&apos;absence *</Label>
        <select
          {...register("type")}
          className={`w-full h-9 rounded-md border bg-background px-3 text-sm ${errors.type ? "border-red-400" : "border-input"}`}
        >
          <option value="">-- Choisir un type --</option>
          {Object.entries(TYPE_LABELS).map(([val, label]) => (
            <option key={val} value={val}>{label}</option>
          ))}
        </select>
        {errors.type && <p className="text-xs text-red-500">{errors.type.message}</p>}
      </div>

      {/* Dates */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Date de début *</Label>
          <Input type="date" {...register("startDate")} className={errors.startDate ? "border-red-400" : ""} />
          {errors.startDate && <p className="text-xs text-red-500">{errors.startDate.message}</p>}
        </div>
        <div className="space-y-1.5">
          <Label>Date de fin *</Label>
          <Input type="date" {...register("endDate")} className={errors.endDate ? "border-red-400" : ""} />
          {errors.endDate && <p className="text-xs text-red-500">{errors.endDate.message}</p>}
        </div>
      </div>

      {/* Raison */}
      <div className="space-y-1.5">
        <Label>Motif (optionnel)</Label>
        <Input placeholder="Raison de l'absence..." {...register("reason")} />
      </div>

      <div className="flex justify-end pt-2">
        <Button type="submit" disabled={isSubmitting} className="bg-[#0f3460] hover:bg-[#0a2540]">
          {isSubmitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Enregistrement...</> : "Enregistrer"}
        </Button>
      </div>
    </form>
  )
}
