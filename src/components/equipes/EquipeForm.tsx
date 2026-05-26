"use client"

import { useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createEquipeSchema, type CreateEquipeInput } from "@/lib/validations/equipe"
import { createEquipe } from "@/lib/actions/equipe.actions"

// Couleurs prédéfinies pour les équipes
const COLORS = [
  "#0f3460", "#e63946", "#2a9d8f", "#e9c46a",
  "#f4a261", "#264653", "#6d6875", "#457b9d",
]

interface Employee {
  id: string
  firstName: string
  lastName: string
  jobTitle: string | null
}

interface EquipeFormProps {
  employees: Employee[]
  onSuccess: () => void
}

export function EquipeForm({ employees, onSuccess }: EquipeFormProps) {
  const [selectedColor, setSelectedColor] = useState(COLORS[0])
  const [selectedMembers, setSelectedMembers] = useState<string[]>([])

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
    watch,
  } = useForm<CreateEquipeInput>({
    resolver: zodResolver(createEquipeSchema),
  })

  const leaderId = watch("leaderId")

  const toggleMember = (id: string) => {
    setSelectedMembers((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]
    )
  }

  const onSubmit = async (data: CreateEquipeInput) => {
    const formData = new FormData()
    formData.append("name", data.name)
    formData.append("color", selectedColor)
    formData.append("leaderId", data.leaderId)
    selectedMembers.forEach((id) => formData.append("memberIds", id))

    const result = await createEquipe(formData)

    if (result?.error) {
      toast.error(result.error)
      return
    }

    toast.success("Équipe créée avec succès !")
    reset()
    setSelectedMembers([])
    onSuccess()
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
      {/* Nom */}
      <div className="space-y-1.5">
        <Label htmlFor="name">Nom de l'équipe *</Label>
        <Input
          id="name"
          placeholder="Équipe Alpha, Équipe Nord..."
          {...register("name")}
          className={errors.name ? "border-red-400" : ""}
        />
        {errors.name && <p className="text-xs text-red-500">{errors.name.message}</p>}
      </div>

      {/* Couleur */}
      <div className="space-y-1.5">
        <Label>Couleur de l'équipe</Label>
        <div className="flex gap-2 flex-wrap">
          {COLORS.map((color) => (
            <button
              key={color}
              type="button"
              onClick={() => setSelectedColor(color)}
              className="w-7 h-7 rounded-full border-2 transition-all"
              style={{
                backgroundColor: color,
                borderColor: selectedColor === color ? "#000" : "transparent",
                transform: selectedColor === color ? "scale(1.2)" : "scale(1)",
              }}
            />
          ))}
        </div>
      </div>

      {/* Chef d'équipe */}
      <div className="space-y-1.5">
        <Label htmlFor="leaderId">Chef d'équipe * <span className="text-slate-400 font-normal text-xs">(obligatoire)</span></Label>
        <select
          id="leaderId"
          {...register("leaderId")}
          className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">-- Sélectionner un chef d'équipe --</option>
          {employees.map((emp) => (
            <option key={emp.id} value={emp.id}>
              {emp.firstName} {emp.lastName}
              {emp.jobTitle ? ` — ${emp.jobTitle}` : ""}
            </option>
          ))}
        </select>
        {errors.leaderId && <p className="text-xs text-red-500">{errors.leaderId.message}</p>}
      </div>

      {/* Membres */}
      <div className="space-y-1.5">
        <Label>Membres de l'équipe <span className="text-slate-400 font-normal text-xs">(optionnel, modifiable après)</span></Label>
        <div className="border rounded-lg divide-y max-h-48 overflow-y-auto">
          {employees.map((emp) => {
            const isLeader = emp.id === leaderId
            const isSelected = selectedMembers.includes(emp.id) || isLeader

            return (
              <label
                key={emp.id}
                className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-slate-50 transition-colors ${isLeader ? "bg-blue-50" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  disabled={isLeader}
                  onChange={() => !isLeader && toggleMember(emp.id)}
                  className="rounded"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-800">
                    {emp.firstName} {emp.lastName}
                    {isLeader && (
                      <span className="ml-2 text-xs text-blue-600 font-normal">Chef</span>
                    )}
                  </p>
                  {emp.jobTitle && (
                    <p className="text-xs text-slate-400">{emp.jobTitle}</p>
                  )}
                </div>
              </label>
            )
          })}
        </div>
        <p className="text-xs text-slate-400">
          {selectedMembers.length + (leaderId ? 1 : 0)} membre(s) sélectionné(s)
        </p>
      </div>

      {/* Bouton */}
      <div className="flex justify-end pt-2">
        <Button type="submit" disabled={isSubmitting} className="bg-[#0f3460] hover:bg-[#0a2540]">
          {isSubmitting ? (
            <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Création...</>
          ) : (
            "Créer l'équipe"
          )}
        </Button>
      </div>
    </form>
  )
}
