"use client"

import { useState } from "react"
import Link from "next/link"
import { Loader2, CheckCircle2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { requestPasswordReset } from "@/lib/actions/password-reset.actions"

export default function MotDePasseOubliePage() {
  const [email,    setEmail]    = useState("")
  const [loading,  setLoading]  = useState(false)
  const [done,     setDone]     = useState(false)
  const [devLink,  setDevLink]  = useState<string | null>(null)
  const [error,    setError]    = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!email) { setError("Veuillez saisir votre email."); return }
    setLoading(true)
    const fd = new FormData()
    fd.append("email", email)
    const result = await requestPasswordReset(fd)
    setLoading(false)
    if (result?.token) {
      setDevLink(`${window.location.origin}/reinitialiser?token=${result.token}`)
    }
    setDone(true)
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center pb-4">
          <div className="w-12 h-12 rounded-xl bg-[#0f3460] text-white flex items-center justify-center font-bold text-lg mx-auto mb-3">P</div>
          <CardTitle className="text-xl">Mot de passe oublié</CardTitle>
        </CardHeader>
        <CardContent>
          {done ? (
            <div className="text-center space-y-4">
              <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto" />
              <p className="text-sm text-slate-600">
                Si un compte existe avec cet email, un lien de réinitialisation a été envoyé.
              </p>
              {devLink && (
                <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-left">
                  <p className="text-xs font-semibold text-amber-800 mb-1">Mode développement</p>
                  <a href={devLink} className="text-xs text-blue-600 underline break-all">{devLink}</a>
                </div>
              )}
              <Link href="/login" className="text-sm text-[#0f3460] underline block">
                Retour à la connexion
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <p className="text-sm text-slate-500">
                Entrez votre email. Nous vous enverrons un lien pour réinitialiser votre mot de passe.
              </p>
              <div className="space-y-1.5">
                <Label>Email</Label>
                <Input
                  type="email"
                  placeholder="vous@exemple.fr"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={error ? "border-red-400" : ""}
                />
                {error && <p className="text-xs text-red-500">{error}</p>}
              </div>
              <Button type="submit" disabled={loading} className="w-full bg-[#0f3460] hover:bg-[#0a2540]">
                {loading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Envoi...</> : "Envoyer le lien"}
              </Button>
              <p className="text-center text-sm text-slate-500">
                <Link href="/login" className="text-[#0f3460] underline">Retour à la connexion</Link>
              </p>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
