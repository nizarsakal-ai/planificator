"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { inviterMembre } from "@/lib/actions/invitation.actions"
import { UserPlus } from "lucide-react"

interface Props {
  companyId:   string
  companyName: string
}

/**
 * Supervision : invitation d'un administrateur dans une entreprise désignée par son id.
 * Le serveur (inviterMembreImpl) vérifie le rôle SUPER_ADMIN, l'existence et l'activité de la cible,
 * puis journalise l'émission ; aucun mot de passe n'est saisi ici (il est choisi à l'acceptation).
 */
export function InviteAdminForm({ companyId, companyName }: Props) {
  const [email, setEmail] = useState("")
  const [loading, setLoading] = useState(false)
  const [invitationUrl, setInvitationUrl] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    setInvitationUrl(null)
    try {
      const fd = new FormData()
      fd.set("email", email.trim().toLowerCase())
      fd.set("role", "ADMIN")
      fd.set("targetCompanyId", companyId)
      const result = await inviterMembre(fd)
      if ("error" in result && result.error) {
        toast.error(result.error)
        return
      }
      setInvitationUrl(("invitationUrl" in result && result.invitationUrl) || null)
      toast.success(`Invitation administrateur émise pour « ${companyName} »`)
      setEmail("")
    } catch {
      toast.error("Erreur lors de l'invitation")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-1">
      <form onSubmit={handleSubmit} className="flex items-center gap-2">
        <label className="sr-only" htmlFor={`invite-admin-${companyId}`}>
          Adresse e-mail du nouvel administrateur de {companyName}
        </label>
        <Input
          id={`invite-admin-${companyId}`}
          type="email"
          required
          autoComplete="off"
          placeholder="admin@exemple.fr"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={loading}
          className="h-8 w-56 text-xs"
        />
        <Button type="submit" variant="outline" size="sm" disabled={loading || email.trim() === ""}>
          <UserPlus className="h-3.5 w-3.5 mr-1.5" />
          Inviter un administrateur
        </Button>
      </form>
      {invitationUrl && (
        <p className="text-xs text-slate-500 break-all">
          Lien d&apos;invitation (valable 7 jours) : <span className="font-mono">{invitationUrl}</span>
        </p>
      )}
    </div>
  )
}
