"use client"

import { useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "sonner"
import { Loader2, User, Lock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { updateProfil, changePassword } from "@/lib/actions/profil.actions"

const profilSchema = z.object({
  name:  z.string().min(1, "Le nom est requis"),
  email: z.string().email("Email invalide"),
})

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword:     z.string().min(8, "8 caractères minimum"),
  confirmPassword: z.string(),
}).refine((d) => d.newPassword === d.confirmPassword, {
  message: "Les mots de passe ne correspondent pas",
  path: ["confirmPassword"],
})

type ProfilInput    = z.infer<typeof profilSchema>
type PasswordInput  = z.infer<typeof passwordSchema>

interface Props {
  user: { id: string; name: string | null; email: string; role: string; companyId?: string | null }
}

export function ProfilForm({ user }: Props) {
  // ─── Infos générales ──────────────────────────────────────────────────────
  const {
    register: regProfil,
    handleSubmit: handleProfil,
    formState: { errors: errProfil, isSubmitting: subProfil },
  } = useForm<ProfilInput>({
    resolver: zodResolver(profilSchema),
    defaultValues: { name: user.name ?? "", email: user.email },
  })

  const onProfil = async (data: ProfilInput) => {
    const fd = new FormData()
    fd.append("name",  data.name)
    fd.append("email", data.email)
    const result = await updateProfil(fd)
    if (result?.error) toast.error(result.error)
    else toast.success("Profil mis à jour.")
  }

  // ─── Mot de passe ─────────────────────────────────────────────────────────
  const {
    register: regPwd,
    handleSubmit: handlePwd,
    formState: { errors: errPwd, isSubmitting: subPwd },
    reset: resetPwd,
  } = useForm<PasswordInput>({ resolver: zodResolver(passwordSchema) })

  const onPassword = async (data: PasswordInput) => {
    const fd = new FormData()
    fd.append("currentPassword", data.currentPassword)
    fd.append("newPassword",     data.newPassword)
    fd.append("confirmPassword", data.confirmPassword)
    const result = await changePassword(fd)
    if (result?.error) toast.error(result.error)
    else { toast.success("Mot de passe modifié."); resetPwd() }
  }

  const roleLabels: Record<string, string> = {
    SUPER_ADMIN:  "Super Admin",
    ADMIN:        "Administrateur",
    TEAM_LEADER:  "Chef d'équipe",
    EMPLOYEE:     "Employé",
  }

  return (
    <div className="space-y-6 max-w-lg">
      {/* Infos générales */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <User className="h-4 w-4" /> Informations personnelles
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleProfil(onProfil)} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="name">Nom complet</Label>
              <Input id="name" {...regProfil("name")} className={errProfil.name ? "border-red-400" : ""} />
              {errProfil.name && <p className="text-xs text-red-500">{errProfil.name.message}</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" {...regProfil("email")} className={errProfil.email ? "border-red-400" : ""} />
              {errProfil.email && <p className="text-xs text-red-500">{errProfil.email.message}</p>}
            </div>

            <div className="space-y-1.5">
              <Label>Rôle</Label>
              <Input value={roleLabels[user.role] ?? user.role} disabled className="bg-slate-50 text-slate-500" />
            </div>

            <div className="flex justify-end">
              <Button type="submit" disabled={subProfil} className="bg-[#0f3460] hover:bg-[#0a2540]">
                {subProfil ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Enregistrement...</> : "Enregistrer"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Mot de passe */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Lock className="h-4 w-4" /> Changer le mot de passe
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handlePwd(onPassword)} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="currentPassword">Mot de passe actuel</Label>
              <Input id="currentPassword" type="password" {...regPwd("currentPassword")} className={errPwd.currentPassword ? "border-red-400" : ""} />
              {errPwd.currentPassword && <p className="text-xs text-red-500">{errPwd.currentPassword.message}</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="newPassword">Nouveau mot de passe</Label>
              <Input id="newPassword" type="password" {...regPwd("newPassword")} className={errPwd.newPassword ? "border-red-400" : ""} />
              {errPwd.newPassword && <p className="text-xs text-red-500">{errPwd.newPassword.message}</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="confirmPassword">Confirmer le mot de passe</Label>
              <Input id="confirmPassword" type="password" {...regPwd("confirmPassword")} className={errPwd.confirmPassword ? "border-red-400" : ""} />
              {errPwd.confirmPassword && <p className="text-xs text-red-500">{errPwd.confirmPassword.message}</p>}
            </div>

            <div className="flex justify-end">
              <Button type="submit" disabled={subPwd} className="bg-[#0f3460] hover:bg-[#0a2540]">
                {subPwd ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Modification...</> : "Modifier le mot de passe"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
