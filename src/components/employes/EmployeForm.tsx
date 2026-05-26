"use client"

import { useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2, Eye, EyeOff } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createEmployeSchema, type CreateEmployeInput } from "@/lib/validations/employe"
import { createEmploye } from "@/lib/actions/employe.actions"

interface EmployeFormProps {
  onSuccess: () => void
}

export function EmployeForm({ onSuccess }: EmployeFormProps) {
  const [showPassword, setShowPassword] = useState(false)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
  } = useForm<CreateEmployeInput>({
    resolver: zodResolver(createEmployeSchema),
    defaultValues: { password: "Admin123!" },
  })

  const onSubmit = async (data: CreateEmployeInput) => {
    const formData = new FormData()
    Object.entries(data).forEach(([k, v]) => formData.append(k, v ?? ""))

    const result = await createEmploye(formData)

    if (result?.error) {
      toast.error(result.error)
      return
    }

    toast.success("Employé créé avec succès !")
    reset()
    onSuccess()
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      {/* Prénom + Nom */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="firstName">Prénom *</Label>
          <Input
            id="firstName"
            placeholder="Jean"
            disabled={isSubmitting}
            {...register("firstName")}
            className={errors.firstName ? "border-red-400" : ""}
          />
          {errors.firstName && (
            <p className="text-xs text-red-500">{errors.firstName.message}</p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lastName">Nom *</Label>
          <Input
            id="lastName"
            placeholder="Dupont"
            disabled={isSubmitting}
            {...register("lastName")}
            className={errors.lastName ? "border-red-400" : ""}
          />
          {errors.lastName && (
            <p className="text-xs text-red-500">{errors.lastName.message}</p>
          )}
        </div>
      </div>

      {/* Email */}
      <div className="space-y-1.5">
        <Label htmlFor="email">Email *</Label>
        <Input
          id="email"
          type="email"
          placeholder="jean.dupont@entreprise.fr"
          disabled={isSubmitting}
          {...register("email")}
          className={errors.email ? "border-red-400" : ""}
        />
        {errors.email && (
          <p className="text-xs text-red-500">{errors.email.message}</p>
        )}
      </div>

      {/* Poste */}
      <div className="space-y-1.5">
        <Label htmlFor="jobTitle">Poste</Label>
        <Input
          id="jobTitle"
          placeholder="Technicien, Maçon, Chef de chantier..."
          disabled={isSubmitting}
          {...register("jobTitle")}
        />
      </div>

      {/* Téléphone */}
      <div className="space-y-1.5">
        <Label htmlFor="phone">Téléphone</Label>
        <Input
          id="phone"
          type="tel"
          placeholder="06 12 34 56 78"
          disabled={isSubmitting}
          {...register("phone")}
        />
      </div>

      {/* Mot de passe */}
      <div className="space-y-1.5">
        <Label htmlFor="password">Mot de passe provisoire *</Label>
        <div className="relative">
          <Input
            id="password"
            type={showPassword ? "text" : "password"}
            disabled={isSubmitting}
            {...register("password")}
            className={errors.password ? "border-red-400 pr-10" : "pr-10"}
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            tabIndex={-1}
          >
            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        {errors.password && (
          <p className="text-xs text-red-500">{errors.password.message}</p>
        )}
        <p className="text-xs text-slate-400">
          L'employé pourra le changer à sa première connexion.
        </p>
      </div>

      {/* Bouton */}
      <div className="flex justify-end gap-3 pt-2">
        <Button type="submit" disabled={isSubmitting} className="bg-[#0f3460] hover:bg-[#0a2540]">
          {isSubmitting ? (
            <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Création...</>
          ) : (
            "Créer l'employé"
          )}
        </Button>
      </div>
    </form>
  )
}
