"use client"

import { useEffect, useState } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { Loader2, CheckCircle2, XCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { getInvitation, acceptInvitation } from "@/lib/actions/invitation.actions"

const schema = z.object({
  name:            z.string().min(1, "Le nom est requis"),
  password:        z.string().min(8, "8 caractères minimum"),
  confirmPassword: z.string(),
}).refine((d) => d.password === d.confirmPassword, {
  message: "Les mots de passe ne correspondent pas",
  path: ["confirmPassword"],
})
type FormData = z.infer<typeof schema>

export default function InvitationPage() {
  const params = useSearchParams()
  const router = useRouter()
  const token  = params.get("token") ?? ""

  const [companyName, setCompanyName] = useState<string | null>(null)
  const [loading,     setLoading]     = useState(true)
  const [invalid,     setInvalid]     = useState(false)
  const [done,        setDone]        = useState(false)

  useEffect(() => {
    if (!token) { setInvalid(true); setLoading(false); return }
    getInvitation(token).then((inv) => {
      if (!inv) { setInvalid(true) } else { setCompanyName(inv.company.name) }
      setLoading(false)
    })
  }, [token])

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<FormData>({ resolver: zodResolver(schema) })

  const onSubmit = async (data: FormData) => {
    const fd = new FormData()
    fd.append("token",           token)
    fd.append("name",            data.name)
    fd.append("password",        data.password)
    fd.append("confirmPassword", data.confirmPassword)
    const result = await acceptInvitation(fd)
    if (result?.error) { setError("root", { message: result.error }); return }
    setDone(true)
    setTimeout(() => router.push("/login"), 2500)
  }

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
    </div>
  )

  if (invalid) return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <Card className="w-full max-w-md text-center">
        <CardContent className="py-12">
          <XCircle className="h-12 w-12 text-red-400 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-slate-800 mb-2">Invitation invalide</h2>
          <p className="text-sm text-slate-500">Ce lien est invalide ou a expiré.</p>
          <Button className="mt-6 bg-[#0f3460] hover:bg-[#0a2540]" onClick={() => router.push("/login")}>
            Retour à la connexion
          </Button>
        </CardContent>
      </Card>
    </div>
  )

  if (done) return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <Card className="w-full max-w-md text-center">
        <CardContent className="py-12">
          <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-slate-800 mb-2">Compte créé !</h2>
          <p className="text-sm text-slate-500">Redirection vers la connexion...</p>
        </CardContent>
      </Card>
    </div>
  )

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center pb-4">
          <div className="w-12 h-12 rounded-xl bg-[#0f3460] text-white flex items-center justify-center font-bold text-lg mx-auto mb-3">P</div>
          <CardTitle className="text-xl">Créer votre compte</CardTitle>
          {companyName && <p className="text-sm text-slate-500 mt-1">Vous rejoignez <strong>{companyName}</strong></p>}
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-1.5">
              <Label>Nom complet *</Label>
              <Input placeholder="Jean Dupont" {...register("name")} className={errors.name ? "border-red-400" : ""} />
              {errors.name && <p className="text-xs text-red-500">{errors.name.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Mot de passe *</Label>
              <Input type="password" {...register("password")} className={errors.password ? "border-red-400" : ""} />
              {errors.password && <p className="text-xs text-red-500">{errors.password.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Confirmer le mot de passe *</Label>
              <Input type="password" {...register("confirmPassword")} className={errors.confirmPassword ? "border-red-400" : ""} />
              {errors.confirmPassword && <p className="text-xs text-red-500">{errors.confirmPassword.message}</p>}
            </div>
            {errors.root && <p className="text-xs text-red-500 text-center">{errors.root.message}</p>}
            <Button type="submit" disabled={isSubmitting} className="w-full bg-[#0f3460] hover:bg-[#0a2540]">
              {isSubmitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Création...</> : "Créer mon compte"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
