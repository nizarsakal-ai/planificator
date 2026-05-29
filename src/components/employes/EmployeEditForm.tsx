"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { updateEmploye } from "@/lib/actions/employe.actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2, Save } from "lucide-react"

interface Props {
  employeeId:    string
  defaultValues: {
    firstName: string
    lastName:  string
    email:     string
    jobTitle:  string
    phone:     string
    hiredAt:   string
  }
}

export function EmployeEditForm({ employeeId, defaultValues }: Props) {
  const router  = useRouter()
  const [loading, setLoading] = useState(false)
  const [saved,   setSaved]   = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    setSaved(false)
    const fd     = new FormData(e.currentTarget)
    const result = await updateEmploye(employeeId, fd)
    setLoading(false)
    if (result?.error) { toast.error(result.error); return }
    toast.success("Informations mises à jour.")
    setSaved(true)
    router.refresh()
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs text-slate-600">Prénom *</Label>
          <Input name="firstName" defaultValue={defaultValues.firstName} required className="h-9 text-sm" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-slate-600">Nom *</Label>
          <Input name="lastName" defaultValue={defaultValues.lastName} required className="h-9 text-sm" />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs text-slate-600">Email *</Label>
        <Input name="email" type="email" defaultValue={defaultValues.email} required className="h-9 text-sm" />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs text-slate-600">Poste / Métier</Label>
        <Input name="jobTitle" list="jobTitle-edit-options" defaultValue={defaultValues.jobTitle} placeholder="Chef d'équipe, Technicien monteur…" className="h-9 text-sm" />
        <datalist id="jobTitle-edit-options">
          <option value="Chef d'équipe" />
          <option value="Technicien monteur" />
          <option value="Cariste" />
          <option value="Assistant responsable" />
          <option value="Électricien" />
        </datalist>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs text-slate-600">Téléphone</Label>
        <Input name="phone" defaultValue={defaultValues.phone} placeholder="06 00 00 00 00" className="h-9 text-sm" />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs text-slate-600">Date d&apos;embauche</Label>
        <Input name="hiredAt" type="date" defaultValue={defaultValues.hiredAt} className="h-9 text-sm" />
      </div>

      <Button
        type="submit"
        disabled={loading}
        className={`w-full h-9 text-sm ${saved ? "bg-green-600 hover:bg-green-700" : "bg-[#0f3460] hover:bg-[#0f3460]/90"} text-white`}
      >
        {loading
          ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Sauvegarde…</>
          : <><Save className="h-4 w-4 mr-2" />Enregistrer</>
        }
      </Button>
    </form>
  )
}
