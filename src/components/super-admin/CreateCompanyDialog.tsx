"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { createCompanyAsAdmin } from "@/lib/actions/register.actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Plus, Loader2 } from "lucide-react"

export function CreateCompanyDialog() {
  const router = useRouter()
  const [open,    setOpen]    = useState(false)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState("")
  const [success, setSuccess] = useState("")

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    setError("")
    setSuccess("")

    const fd     = new FormData(e.currentTarget)
    const result = await createCompanyAsAdmin(fd)

    setLoading(false)
    if (result.error) { setError(result.error); return }

    setSuccess("Entreprise créée !")
    router.refresh()
    setTimeout(() => { setOpen(false); setSuccess("") }, 1500)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); setError(""); setSuccess("") }}>
      <DialogTrigger asChild>
        <Button className="bg-[#0f3460] hover:bg-[#0f3460]/90 text-white h-9 text-sm">
          <Plus className="h-4 w-4 mr-2" />
          Nouvelle entreprise
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base">Créer une entreprise</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-1.5">
            <Label htmlFor="companyName" className="text-sm">Nom de l&apos;entreprise *</Label>
            <Input
              id="companyName"
              name="companyName"
              placeholder="BTP Exemple"
              required
              className="h-9"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="adminEmail" className="text-sm">
              Email du premier admin <span className="text-slate-400">(optionnel)</span>
            </Label>
            <Input
              id="adminEmail"
              name="adminEmail"
              type="email"
              placeholder="admin@exemple.fr"
              className="h-9"
            />
            <p className="text-xs text-slate-400">Une invitation lui sera envoyée par email.</p>
          </div>

          {error   && <p className="text-sm text-red-600 bg-red-50 rounded px-3 py-2">{error}</p>}
          {success && <p className="text-sm text-green-600 bg-green-50 rounded px-3 py-2">{success}</p>}

          <div className="flex gap-2 pt-1">
            <Button type="button" variant="outline" className="flex-1 h-9 text-sm" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={loading} className="flex-1 bg-[#0f3460] hover:bg-[#0f3460]/90 text-white h-9 text-sm">
              {loading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Créer
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
