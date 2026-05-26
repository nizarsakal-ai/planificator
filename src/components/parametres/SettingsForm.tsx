"use client"

import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { updateCompanySettings } from "@/lib/actions/parametres.actions"

const schema = z.object({
  defaultDailyHours: z.coerce.number().min(1).max(24),
  timezone:          z.string(),
})

type FormData = z.infer<typeof schema>

const TIMEZONES = [
  "Europe/Paris",
  "Europe/London",
  "Europe/Brussels",
  "Europe/Zurich",
  "Europe/Madrid",
  "Africa/Tunis",
  "Africa/Casablanca",
  "America/Montreal",
]

interface Props {
  settings: { defaultDailyHours: number; timezone: string } | null
}

export function SettingsForm({ settings }: Props) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      defaultDailyHours: settings?.defaultDailyHours ?? 10,
      timezone:          settings?.timezone          ?? "Europe/Paris",
    },
  })

  const onSubmit = async (data: FormData) => {
    const fd = new FormData()
    fd.append("defaultDailyHours", String(data.defaultDailyHours))
    fd.append("timezone",          data.timezone)
    const result = await updateCompanySettings(fd)
    if (result?.error) toast.error(result.error)
    else toast.success("Paramètres enregistrés.")
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1.5">
        <Label>Heures de travail par défaut</Label>
        <Input
          type="number"
          min={1}
          max={24}
          {...register("defaultDailyHours")}
          className={errors.defaultDailyHours ? "border-red-400" : ""}
        />
        <p className="text-xs text-slate-400">Utilisé par défaut à la création d&apos;un chantier.</p>
        {errors.defaultDailyHours && <p className="text-xs text-red-500">{errors.defaultDailyHours.message}</p>}
      </div>

      <div className="space-y-1.5">
        <Label>Fuseau horaire</Label>
        <select
          {...register("timezone")}
          className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          {TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>{tz}</option>
          ))}
        </select>
      </div>

      <div className="flex justify-end pt-2">
        <Button type="submit" disabled={isSubmitting} className="bg-[#0f3460] hover:bg-[#0a2540]">
          {isSubmitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Enregistrement...</> : "Enregistrer"}
        </Button>
      </div>
    </form>
  )
}
