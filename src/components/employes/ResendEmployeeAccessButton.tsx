"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { resendEmployeeAccessEmail } from "@/lib/actions/employe.actions"

/** Renvoi de l'e-mail d'accès à ce seul salarié (le renvoi groupé reste sur la liste des employés). */
export function ResendEmployeeAccessButton({ employeeId, employeeName, email }: { employeeId: string; employeeName: string; email: string }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)

  const handleResend = async () => {
    setLoading(true)
    try {
      const result = await resendEmployeeAccessEmail(employeeId)
      if (result.success) {
        toast.success(result.kind === "INVITATION"
          ? `Invitation envoyée à ${result.email} : son compte sera activé dès qu'il l'aura acceptée.`
          : `E-mail d'accès envoyé à ${result.email}.`)
        setOpen(false)
      } else {
        toast.error(result.error)
      }
    } catch {
      toast.error("L'e-mail d'accès n'a pas pu être envoyé. Réessayez.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-[#0f3460] hover:bg-blue-50">
          <Send className="h-4 w-4 mr-1" /> Renvoyer l&apos;accès
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Renvoyer l&apos;accès à {employeeName} ?</DialogTitle>
          <DialogDescription>
            Un e-mail sera envoyé uniquement à <strong>{email}</strong> avec un lien pour définir ou réinitialiser
            son mot de passe (valable 72 h), ou une invitation si son compte n'a jamais été activé. Tout lien précédent
            encore inutilisé sera remplacé.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={loading}>Annuler</Button>
          <Button onClick={handleResend} disabled={loading}>{loading ? "Envoi en cours…" : "Confirmer l'envoi"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
