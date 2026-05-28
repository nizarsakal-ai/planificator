"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent } from "@/components/ui/card"
import { updateCompanyInfo } from "@/lib/actions/parametres.actions"
import { inviterMembre } from "@/lib/actions/invitation.actions"
import {
  Building2,
  UserPlus,
  CheckCircle2,
  ArrowRight,
  ChevronRight,
  Loader2,
} from "lucide-react"
import { cn } from "@/lib/utils"

const STEPS = [
  { id: 1, label: "Entreprise", icon: Building2   },
  { id: 2, label: "Équipe",     icon: UserPlus    },
  { id: 3, label: "Terminé",    icon: CheckCircle2 },
]

export function OnboardingWizard({ companyName }: { companyName: string }) {
  const router = useRouter()
  const [step,    setStep]    = useState(1)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState("")

  // ─── Step 1 : Profil entreprise ───────────────────────────────────────────

  async function handleCompanyStep(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    setError("")
    const fd = new FormData(e.currentTarget)
    const result = await updateCompanyInfo(fd)
    setLoading(false)
    if (result?.error) { setError(result.error); return }
    setStep(2)
  }

  // ─── Step 2 : Inviter un membre ───────────────────────────────────────────

  async function handleInviteStep(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    setError("")
    const fd = new FormData(e.currentTarget)
    const result = await inviterMembre(fd)
    setLoading(false)
    if (result?.error) { setError(result.error); return }
    setStep(3)
  }

  return (
    <div className="max-w-xl mx-auto py-6 space-y-8">
      {/* Titre */}
      <div className="text-center">
        <h1 className="text-2xl font-bold text-slate-900">Bienvenue sur Planificator !</h1>
        <p className="text-sm text-slate-500 mt-1">Configurez votre espace en 2 étapes rapides.</p>
      </div>

      {/* Stepper */}
      <div className="flex items-center justify-center gap-2">
        {STEPS.map((s, i) => (
          <div key={s.id} className="flex items-center gap-2">
            <div
              className={cn(
                "w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 transition-colors",
                step > s.id   ? "bg-green-500 text-white" :
                step === s.id ? "bg-[#0f3460] text-white" :
                                "bg-slate-100 text-slate-400"
              )}
            >
              {step > s.id ? <CheckCircle2 className="h-4 w-4" /> : s.id}
            </div>
            <span className={cn(
              "text-xs font-medium hidden sm:inline",
              step === s.id ? "text-[#0f3460]" : "text-slate-400"
            )}>
              {s.label}
            </span>
            {i < STEPS.length - 1 && (
              <ChevronRight className="h-4 w-4 text-slate-300 mx-1" />
            )}
          </div>
        ))}
      </div>

      {/* ── Step 1 ── */}
      {step === 1 && (
        <Card>
          <CardContent className="p-6 space-y-5">
            <div>
              <h2 className="font-semibold text-slate-800 flex items-center gap-2">
                <Building2 className="h-4 w-4 text-[#0f3460]" />
                Complétez votre profil entreprise
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">Ces informations apparaîtront sur vos exports et documents.</p>
            </div>

            <form onSubmit={handleCompanyStep} className="space-y-4">
              {/* Champ name requis par updateCompanyInfo, pré-rempli */}
              <input type="hidden" name="name" value={companyName} />

              <div className="space-y-1.5">
                <Label htmlFor="phone" className="text-sm">Téléphone</Label>
                <Input id="phone" name="phone" placeholder="01 23 45 67 89" className="h-9" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="address" className="text-sm">Adresse</Label>
                <Input id="address" name="address" placeholder="12 rue de la Paix, 75001 Paris" className="h-9" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="siret" className="text-sm">SIRET</Label>
                <Input id="siret" name="siret" placeholder="000 000 000 00000" className="h-9" />
              </div>

              {error && <p className="text-sm text-red-600 bg-red-50 rounded px-3 py-2">{error}</p>}

              <div className="flex gap-3 pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  className="text-slate-500 text-sm"
                  onClick={() => setStep(2)}
                >
                  Passer
                </Button>
                <Button
                  type="submit"
                  disabled={loading}
                  className="flex-1 bg-[#0f3460] hover:bg-[#0f3460]/90 text-white"
                >
                  {loading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                  Continuer <ArrowRight className="h-4 w-4 ml-2" />
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* ── Step 2 ── */}
      {step === 2 && (
        <Card>
          <CardContent className="p-6 space-y-5">
            <div>
              <h2 className="font-semibold text-slate-800 flex items-center gap-2">
                <UserPlus className="h-4 w-4 text-[#0f3460]" />
                Invitez votre premier collaborateur
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">Envoyez une invitation par email. Vous pouvez en ajouter d&apos;autres plus tard.</p>
            </div>

            <form onSubmit={handleInviteStep} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="email" className="text-sm">Email du collaborateur</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  placeholder="prenom.nom@entreprise.fr"
                  className="h-9"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="role" className="text-sm">Rôle</Label>
                <select
                  name="role"
                  id="role"
                  defaultValue="TEAM_LEADER"
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#0f3460]/30"
                >
                  <option value="ADMIN">Administrateur</option>
                  <option value="TEAM_LEADER">Chef d&apos;équipe</option>
                  <option value="EMPLOYEE">Employé</option>
                </select>
              </div>

              {error && <p className="text-sm text-red-600 bg-red-50 rounded px-3 py-2">{error}</p>}

              <div className="flex gap-3 pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  className="text-slate-500 text-sm"
                  onClick={() => setStep(3)}
                >
                  Passer
                </Button>
                <Button
                  type="submit"
                  disabled={loading}
                  className="flex-1 bg-[#0f3460] hover:bg-[#0f3460]/90 text-white"
                >
                  {loading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                  Envoyer l&apos;invitation <ArrowRight className="h-4 w-4 ml-2" />
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* ── Step 3 : Terminé ── */}
      {step === 3 && (
        <Card>
          <CardContent className="p-8 text-center space-y-5">
            <div className="w-16 h-16 rounded-full bg-green-50 flex items-center justify-center mx-auto">
              <CheckCircle2 className="h-8 w-8 text-green-500" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-slate-900">Votre espace est prêt !</h2>
              <p className="text-sm text-slate-500 mt-2">
                Vous pouvez maintenant créer vos équipes, chantiers et plannings.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-2 text-sm text-left bg-slate-50 rounded-lg p-4">
              <p className="text-slate-600">→ Ajoutez vos <span className="font-medium">employés</span> dans le menu Employés</p>
              <p className="text-slate-600">→ Créez vos <span className="font-medium">équipes</span></p>
              <p className="text-slate-600">→ Ajoutez vos <span className="font-medium">clients</span> et <span className="font-medium">chantiers</span></p>
            </div>
            <Button
              onClick={() => router.push("/dashboard")}
              className="w-full bg-[#0f3460] hover:bg-[#0f3460]/90 text-white"
            >
              Aller au tableau de bord <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
