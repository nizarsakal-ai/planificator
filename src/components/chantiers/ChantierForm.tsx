"use client"

import { useState } from "react"
import { Controller, useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2, Plus } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { ClientForm } from "@/components/clients/ClientForm"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createChantierSchema, type CreateChantierInput } from "@/lib/validations/chantier"
import { createChantierWithId } from "@/lib/actions/chantier.actions"

interface Client {
  id: string
  name: string
}

interface ChantierFormProps {
  clients: Client[]
  initialClientId?: string
  onSuccess: (worksiteId: string) => void
}

export function ChantierForm({ clients, initialClientId = "", onSuccess }: ChantierFormProps) {
  const [clientDialogOpen, setClientDialogOpen] = useState(false)
  const [addedClients, setAddedClients] = useState<Client[]>([])
  const clientOptions = [...clients, ...addedClients.filter((added) => !clients.some((client) => client.id === added.id))]
  const today = new Date().toISOString().split("T")[0]

  const {
    register,
    control,
    setValue,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
  } = useForm<CreateChantierInput>({
    resolver: zodResolver(createChantierSchema),
    defaultValues: { clientId: initialClientId, dailyHours: 10, startDate: today },
  })

  const onSubmit = async (data: CreateChantierInput) => {
    const formData = new FormData()
    Object.entries(data).forEach(([k, v]) => {
      if (v !== undefined && v !== null) formData.append(k, String(v))
    })

    const result = await createChantierWithId(formData)

    if (!result.worksiteId) {
      toast.error(result.error ?? "Création du chantier impossible.")
      return
    }

    toast.success("Chantier créé avec succès !")
    reset()
    onSuccess(result.worksiteId)
  }

  return (
    <Dialog open={clientDialogOpen} onOpenChange={setClientDialogOpen}>
      <form onSubmit={(event) => {
        event.stopPropagation()
        void handleSubmit(onSubmit)(event)
      }} className="space-y-4">
        {/* Nom */}
        <div className="space-y-1.5">
          <Label htmlFor="name">Nom du chantier *</Label>
          <Input
            id="name"
            placeholder="Rénovation façade, Installation électrique..."
            {...register("name")}
            className={errors.name ? "border-red-400" : ""}
          />
          {errors.name && <p className="text-xs text-red-500">{errors.name.message}</p>}
        </div>

        {/* Client */}
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label htmlFor="clientId">Client *</Label>
            <DialogTrigger asChild>
              <Button type="button" variant="outline" size="sm">
                <Plus className="mr-1 h-4 w-4" />
                Ajouter un client
              </Button>
            </DialogTrigger>
          </div>
          <Controller
            name="clientId"
            control={control}
            render={({ field }) => (
              <select
                id="clientId"
                {...field}
                className={`w-full h-9 rounded-md border bg-background px-3 text-sm ${errors.clientId ? "border-red-400" : "border-input"}`}
              >
                <option value="">-- Sélectionner un client --</option>
                {clientOptions.map((client) => (
                  <option key={client.id} value={client.id}>{client.name}</option>
                ))}
              </select>
            )}
          />
          {errors.clientId && <p className="text-xs text-red-500">{errors.clientId.message}</p>}
        </div>

        {/* Adresse */}
        <div className="space-y-1.5">
          <Label htmlFor="address">Adresse du chantier</Label>
          <Input
            id="address"
            placeholder="15 rue du Chantier, 75001 Paris"
            {...register("address")}
          />
        </div>

        {/* Dates */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="startDate">Date de début *</Label>
            <Input
              id="startDate"
              type="date"
              {...register("startDate")}
              className={errors.startDate ? "border-red-400" : ""}
            />
            {errors.startDate && <p className="text-xs text-red-500">{errors.startDate.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="endDate">Date de fin *</Label>
            <Input
              id="endDate"
              type="date"
              {...register("endDate")}
              className={errors.endDate ? "border-red-400" : ""}
            />
            {errors.endDate && <p className="text-xs text-red-500">{errors.endDate.message}</p>}
          </div>
        </div>

        {/* Heures par jour */}
        <div className="space-y-1.5">
          <Label htmlFor="dailyHours">Heures de travail par jour</Label>
          <Input
            id="dailyHours"
            type="number"
            min={1}
            max={24}
            {...register("dailyHours")}
          />
          <p className="text-xs text-slate-400">Par défaut : 10h/jour</p>
        </div>

        {/* Description */}
        <div className="space-y-1.5">
          <Label htmlFor="description">Description</Label>
          <textarea
            id="description"
            rows={6}
            placeholder="Détails du chantier, travaux à effectuer, instructions particulières, matériaux nécessaires..."
            {...register("description")}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-ring min-h-[120px]"
          />
        </div>

        {/* Bouton */}
        <div className="flex justify-end pt-2">
          <Button type="submit" disabled={isSubmitting} className="bg-[#0f3460] hover:bg-[#0a2540]">
            {isSubmitting ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Création...</>
            ) : (
              "Créer le chantier"
            )}
          </Button>
        </div>
      </form>
      <DialogContent className="max-h-[90vh] overflow-y-auto" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Nouveau client</DialogTitle>
        </DialogHeader>
        <ClientForm onSuccess={(createdClient) => {
          if (createdClient) {
            setAddedClients((previous) => [...previous, createdClient])
            setValue("clientId", createdClient.id, { shouldDirty: true, shouldValidate: true })
          }
          setClientDialogOpen(false)
        }} />
      </DialogContent>
    </Dialog>
  )
}
