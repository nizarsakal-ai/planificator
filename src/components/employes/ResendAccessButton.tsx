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
import { resendAccessEmails } from "@/lib/actions/employe.actions"

export function ResendAccessButton() {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)

  const handleResend = async () => {
    setLoading(true)
    const result = await resendAccessEmails()
    setLoading(false)
    setOpen(false)

    if (!result.success && result.errors && result.errors.length > 0) {
      toast.warning(
        `${result.sent} email(s) envoyé(s). Échec pour : ${result.errors.join(", ")}`
      )
    } else if (result.sent === 0) {
      toast.info("Aucun employé actif trouvé.")
    } else {
      toast.success(`${result.sent} email(s) d'accès envoyé(s) avec succès.`)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Send className="h-4 w-4" />
          Renvoyer les accès
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Renvoyer les emails d&apos;accès ?</DialogTitle>
          <DialogDescription>
            Un email sera envoyé à <strong>tous les employés actifs</strong> avec un lien
            pour définir ou réinitialiser leur mot de passe (valable 72 h).
            Cela leur permettra de se connecter et de consulter leur planning.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={loading}>
            Annuler
          </Button>
          <Button onClick={handleResend} disabled={loading}>
            {loading ? "Envoi en cours…" : "Confirmer l'envoi"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
