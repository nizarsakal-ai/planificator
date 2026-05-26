"use client"

import { useState } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { Loader2, CheckCircle2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { resetPassword } from "@/lib/actions/password-reset.actions"

const schema = z.object({
  password:        z.string().min(8, "8 caractères minimum"),
  confirmPassword: z.string(),
}).refine((d) => d.password === d.confirmPassword, {
  message: "Les mots de passe ne correspondent pas",
  path: ["confirmPassword"],
})
type FormData = z.infer<typeof schema>

export default function ReinitialiserPage() {
  const params = useSearchParams()
  const router = useRouter()
  const token  = params.get("token") ?? ""
  const [done, setDone] = useState(false)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<FormData>({ resolver: zodResolver(schema) })

  const onSubmit = async (data: FormData) => {
    const fd = new FormData()
    fd.append("token",           token)
    fd.append("password",        data.password)
    fd.append("confirmPassword", data.confirmPassword)
    const result = await resetPassword(fd)
    if (result?.error) { setError("root", { message: result.error }); return }
    setDone(true)
    setTimeout(() => router.push("/login"), 2500)
  }

  if (done) return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <Card className="w-full max-w-md text-center">
        <CardContent className="py-12">
          <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-slate-800 mb-2">Mot de passe modifié !</h2>
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
          <CardTitle className="text-xl">Nouveau mot de passe</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-1.5">
              <Label>Nouveau mot de passe *</Label>
              <Input type="password" {...register("password")} className={errors.password ? "border-red-400" : ""} />
              {errors.password && <p className="text-xs text-red-500">{errors.password.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Confirmer *</Label>
              <Input type="password" {...register("confirmPassword")} className={errors.confirmPassword ? "border-red-400" : ""} />
              {errors.confirmPassword && <p className="text-xs text-red-500">{errors.confirmPassword.message}</p>}
            </div>
            {errors.root && <p className="text-xs text-red-500 text-center">{errors.root.message}</p>}
            <Button type="submit" disabled={isSubmitting} className="w-full bg-[#0f3460] hover:bg-[#0a2540]">
              {isSubmitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Modification...</> : "Enregistrer le mot de passe"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
