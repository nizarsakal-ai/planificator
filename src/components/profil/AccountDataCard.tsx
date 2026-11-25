"use client"

import { useState } from "react"
import Link from "next/link"
import { signOut } from "next-auth/react"
import { Download, Loader2, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { deleteOwnAccount } from "@/lib/actions/account.actions"
import { DELETION_CONFIRMATION_WORD } from "@/lib/account/account-deletion.core"

// Lot 2b juridique : « Mes données et mon compte » (export RGPD art. 15/20, suppression Apple 5.1.1(v) / Google Play).

export function AccountDataCard() {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setPending(true)
    setError("")
    let signingOut = false
    try {
      const result = await deleteOwnAccount(new FormData(e.currentTarget))
      if (result.ok) {
        signingOut = true
        await signOut({ callbackUrl: "/login" })
        return
      }
      setError(result.error)
    } catch {
      setError("La suppression n'a pas pu aboutir. Vérifiez votre connexion et réessayez.")
    } finally {
      // Le bouton redevient utilisable dans tous les cas, sauf pendant la déconnexion qui suit une suppression réussie.
      if (!signingOut) setPending(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Mes données et mon compte</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <p className="text-sm text-slate-600">
            Téléchargez une copie des données personnelles liées à votre compte : profil, pointages, absences, notes de
            frais, affectations, titres des notifications.
          </p>
          <Button asChild variant="outline">
            <a href="/api/me/export" download>
              <Download className="mr-2 h-4 w-4" />
              Télécharger mes données
            </a>
          </Button>
        </div>

        <div className="space-y-2 border-t border-slate-100 pt-5">
          <p className="text-sm text-slate-600">
            La suppression efface votre accès, votre e-mail, votre nom de compte, votre téléphone et votre photo. Votre
            employeur garde les informations que la loi l&apos;oblige à conserver (heures, paie, notes de frais), pendant les
            durées indiquées dans la{" "}
            <Link href="/confidentialite" className="text-blue-700 underline">politique de confidentialité</Link>.
          </p>
          <Dialog open={open} onOpenChange={(v) => { setOpen(v); setError("") }}>
            <DialogTrigger asChild>
              <Button variant="outline" className="border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800">
                <Trash2 className="mr-2 h-4 w-4" />
                Supprimer mon compte
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Supprimer définitivement mon compte</DialogTitle>
                <DialogDescription>
                  Cette action est irréversible : vous ne pourrez plus vous connecter avec ce compte.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="delete-password">Votre mot de passe</Label>
                  <Input id="delete-password" name="password" type="password" autoComplete="current-password" required />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="delete-confirmation">Tapez {DELETION_CONFIRMATION_WORD} pour confirmer</Label>
                  <Input id="delete-confirmation" name="confirmation" autoComplete="off" required />
                </div>
                {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>Annuler</Button>
                  <Button type="submit" disabled={pending} className="bg-red-600 text-white hover:bg-red-700">
                    {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                    Supprimer mon compte
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </CardContent>
    </Card>
  )
}
