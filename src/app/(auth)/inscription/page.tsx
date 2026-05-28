"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { signIn } from "next-auth/react"
import { registerCompany } from "@/lib/actions/register.actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2 } from "lucide-react"

export default function InscriptionPage() {
  const router  = useRouter()
  const [error,   setError]   = useState("")
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    setError("")

    const form     = e.currentTarget
    const formData = new FormData(form)

    const password  = formData.get("password")  as string
    const confirm   = formData.get("confirm")   as string
    if (password !== confirm) {
      setError("Les mots de passe ne correspondent pas.")
      setLoading(false)
      return
    }

    const result = await registerCompany(formData)
    if (result.error) {
      setError(result.error)
      setLoading(false)
      return
    }

    // Connexion automatique après création
    const signInResult = await signIn("credentials", {
      email:    formData.get("email")    as string,
      password: formData.get("password") as string,
      redirect: false,
    })

    if (signInResult?.error) {
      router.push("/login")
    } else {
      router.push("/onboarding")
    }
  }

  return (
    <div className="w-full max-w-md">
      {/* Branding */}
      <div className="text-center mb-8">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-[#0f3460] text-white text-2xl font-bold mb-4 shadow-lg">
          P
        </div>
        <h1 className="text-3xl font-bold text-slate-900">Planificator</h1>
        <p className="text-slate-500 mt-1 text-sm">Créez votre espace en quelques secondes</p>
      </div>

      {/* Formulaire */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
        <h2 className="text-xl font-semibold text-slate-800 mb-1">Créer mon entreprise</h2>
        <p className="text-sm text-slate-500 mb-6">Gratuit · Aucune carte requise</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="companyName" className="text-sm text-slate-700">Nom de l&apos;entreprise</Label>
            <Input
              id="companyName"
              name="companyName"
              placeholder="Ex: BTP Dupont & Fils"
              required
              className="h-10"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="adminName" className="text-sm text-slate-700">Votre nom complet</Label>
            <Input
              id="adminName"
              name="adminName"
              placeholder="Jean Dupont"
              required
              className="h-10"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="email" className="text-sm text-slate-700">Email professionnel</Label>
            <Input
              id="email"
              name="email"
              type="email"
              placeholder="jean@dupont-btp.fr"
              required
              className="h-10"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password" className="text-sm text-slate-700">Mot de passe</Label>
            <Input
              id="password"
              name="password"
              type="password"
              placeholder="8 caractères minimum"
              required
              minLength={8}
              className="h-10"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="confirm" className="text-sm text-slate-700">Confirmer le mot de passe</Label>
            <Input
              id="confirm"
              name="confirm"
              type="password"
              placeholder="Répétez le mot de passe"
              required
              className="h-10"
            />
          </div>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>
          )}

          <Button
            type="submit"
            disabled={loading}
            className="w-full bg-[#0f3460] hover:bg-[#0f3460]/90 text-white h-10 mt-2"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Création en cours…
              </>
            ) : (
              "Créer mon espace"
            )}
          </Button>
        </form>
      </div>

      <p className="text-center text-xs text-slate-400 mt-6">
        Déjà un compte ?{" "}
        <Link href="/login" className="text-[#0f3460] underline">
          Se connecter
        </Link>
      </p>
    </div>
  )
}
