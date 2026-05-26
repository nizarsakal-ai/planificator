"use client"

import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createClientSchema, type CreateClientInput } from "@/lib/validations/client"
import { createClient } from "@/lib/actions/client.actions"

interface ClientFormProps {
  onSuccess: () => void
}

export function ClientForm({ onSuccess }: ClientFormProps) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
  } = useForm<CreateClientInput>({
    resolver: zodResolver(createClientSchema),
  })

  const onSubmit = async (data: CreateClientInput) => {
    const formData = new FormData()
    Object.entries(data).forEach(([k, v]) => {
      if (v !== undefined && v !== null) formData.append(k, v)
    })

    const result = await createClient(formData)

    if (result?.error) {
      toast.error(result.error)
      return
    }

    toast.success("Client créé avec succès !")
    reset()
    onSuccess()
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      {/* Nom */}
      <div className="space-y-1.5">
        <Label htmlFor="name">Nom du client *</Label>
        <Input
          id="name"
          placeholder="Entreprise Dupont, M. Martin..."
          {...register("name")}
          className={errors.name ? "border-red-400" : ""}
        />
        {errors.name && <p className="text-xs text-red-500">{errors.name.message}</p>}
      </div>

      {/* Email */}
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          placeholder="contact@client.fr"
          {...register("email")}
          className={errors.email ? "border-red-400" : ""}
        />
        {errors.email && <p className="text-xs text-red-500">{errors.email.message}</p>}
      </div>

      {/* Téléphone */}
      <div className="space-y-1.5">
        <Label htmlFor="phone">Téléphone</Label>
        <Input
          id="phone"
          type="tel"
          placeholder="06 12 34 56 78"
          {...register("phone")}
        />
      </div>

      {/* Adresse */}
      <div className="space-y-1.5">
        <Label htmlFor="address">Adresse</Label>
        <Input
          id="address"
          placeholder="12 rue des Lilas, 75001 Paris"
          {...register("address")}
        />
      </div>

      {/* Notes */}
      <div className="space-y-1.5">
        <Label htmlFor="notes">Notes internes</Label>
        <textarea
          id="notes"
          rows={3}
          placeholder="Informations utiles sur ce client..."
          {...register("notes")}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      {/* Bouton */}
      <div className="flex justify-end pt-2">
        <Button type="submit" disabled={isSubmitting} className="bg-[#0f3460] hover:bg-[#0a2540]">
          {isSubmitting ? (
            <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Création...</>
          ) : (
            "Créer le client"
          )}
        </Button>
      </div>
    </form>
  )
}
