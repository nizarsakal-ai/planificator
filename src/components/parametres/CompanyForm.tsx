"use client"

import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { updateCompanyInfo } from "@/lib/actions/parametres.actions"

const schema = z.object({
  name:    z.string().min(1, "Le nom est requis"),
  email:   z.string().email("Email invalide").optional().or(z.literal("")),
  phone:   z.string().optional(),
  address: z.string().optional(),
  siret:   z.string().optional(),
})

type FormData = z.infer<typeof schema>

interface Props {
  company: {
    name: string
    email: string | null
    phone: string | null
    address: string | null
    siret: string | null
  }
}

export function CompanyForm({ company }: Props) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      name:    company.name,
      email:   company.email    ?? "",
      phone:   company.phone    ?? "",
      address: company.address  ?? "",
      siret:   company.siret    ?? "",
    },
  })

  const onSubmit = async (data: FormData) => {
    const fd = new FormData()
    Object.entries(data).forEach(([k, v]) => fd.append(k, v ?? ""))
    const result = await updateCompanyInfo(fd)
    if (result?.error) toast.error(result.error)
    else toast.success("Informations mises à jour.")
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1.5">
        <Label>Nom de l&apos;entreprise *</Label>
        <Input {...register("name")} className={errors.name ? "border-red-400" : ""} />
        {errors.name && <p className="text-xs text-red-500">{errors.name.message}</p>}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Email</Label>
          <Input type="email" {...register("email")} className={errors.email ? "border-red-400" : ""} />
          {errors.email && <p className="text-xs text-red-500">{errors.email.message}</p>}
        </div>
        <div className="space-y-1.5">
          <Label>Téléphone</Label>
          <Input {...register("phone")} placeholder="01 23 45 67 89" />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Adresse</Label>
        <Input {...register("address")} placeholder="15 rue de la Paix, 75001 Paris" />
      </div>

      <div className="space-y-1.5">
        <Label>SIRET</Label>
        <Input {...register("siret")} placeholder="123 456 789 00010" />
      </div>

      <div className="flex justify-end pt-2">
        <Button type="submit" disabled={isSubmitting} className="bg-[#0f3460] hover:bg-[#0a2540]">
          {isSubmitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Enregistrement...</> : "Enregistrer"}
        </Button>
      </div>
    </form>
  )
}
