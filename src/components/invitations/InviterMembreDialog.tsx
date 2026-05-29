"use client"

import { useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "sonner"
import { UserPlus, Loader2, Copy } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { inviterMembre } from "@/lib/actions/invitation.actions"

const schema = z.object({
  email: z.string().email("Email invalide"),
  role:  z.enum(["ADMIN", "TEAM_LEADER", "EMPLOYEE"]),
})
type FormData = z.infer<typeof schema>

export function InviterMembreDialog() {
  const [open, setOpen]             = useState(false)
  const [invitationUrl, setInvitationUrl] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { role: "EMPLOYEE" },
  })

  const onSubmit = async (data: FormData) => {
    const fd = new FormData()
    fd.append("email", data.email)
    fd.append("role",  data.role)
    const result = await inviterMembre(fd)

    if (result?.error) { toast.error(result.error); return }

    setInvitationUrl(result.invitationUrl ?? null)
  }

  const copyLink = () => {
    if (invitationUrl) { navigator.clipboard.writeText(invitationUrl); toast.success("Lien copié !") }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { reset(); setInvitationUrl(null) } }}>
      <DialogTrigger asChild>
        <Button variant="outline" className="border-[#0f3460] text-[#0f3460] hover:bg-[#0f3460] hover:text-white">
          <UserPlus className="h-4 w-4 mr-2" /> Inviter un membre
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Inviter un membre</DialogTitle>
        </DialogHeader>

        {invitationUrl ? (
          <div className="space-y-4">
            <div className="rounded-lg bg-green-50 border border-green-200 p-4 text-sm text-green-800">
              <p className="font-semibold mb-1">Invitation créée ✓</p>
              <p className="text-xs">Un email a été envoyé. Si la personne ne le reçoit pas, copiez ce lien et envoyez-le par SMS ou WhatsApp :</p>
            </div>
            <div className="flex gap-2">
              <Input value={invitationUrl} readOnly className="text-xs" />
              <Button size="icon" variant="outline" onClick={copyLink}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <Button className="w-full bg-[#0f3460] hover:bg-[#0a2540]" onClick={() => { setOpen(false); reset(); setInvitationUrl(null) }}>
              Fermer
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-1.5">
              <Label>Email *</Label>
              <Input type="email" placeholder="employe@exemple.fr" {...register("email")} className={errors.email ? "border-red-400" : ""} />
              {errors.email && <p className="text-xs text-red-500">{errors.email.message}</p>}
            </div>

            <div className="space-y-1.5">
              <Label>Rôle *</Label>
              <select {...register("role")} className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm">
                <option value="EMPLOYEE">Employé</option>
                <option value="TEAM_LEADER">Chef d&apos;équipe</option>
                <option value="ADMIN">Administrateur</option>
              </select>
            </div>

            <p className="text-xs text-slate-400">
              Un email d&apos;invitation sera envoyé avec un lien pour créer le compte.
            </p>

            <div className="flex justify-end pt-2">
              <Button type="submit" disabled={isSubmitting} className="bg-[#0f3460] hover:bg-[#0a2540]">
                {isSubmitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Envoi...</> : "Envoyer l'invitation"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
