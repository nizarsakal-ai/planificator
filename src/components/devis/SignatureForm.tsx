"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { refuseQuotePublicAction, signQuoteAction } from "@/lib/actions/quote.actions"

export function SignatureForm({ token }: { token: string }) {
  const router = useRouter()
  const [name, setName] = useState("")
  const [approved, setApproved] = useState(false)
  const [busy, setBusy] = useState<"sign" | "refuse" | null>(null)

  async function sign(e: React.FormEvent) {
    e.preventDefault()
    setBusy("sign")
    try {
      const r = await signQuoteAction(token, { signerName: name, approved: approved as true })
      if (!r.ok) { toast.error(r.error); return }
      toast.success("Devis signé. Merci !")
      router.refresh()
    } catch { toast.error("Erreur serveur, réessayez.") } finally { setBusy(null) }
  }
  async function refuse() {
    const reason = window.prompt("Motif du refus (facultatif) :", "")
    if (reason === null) return
    setBusy("refuse")
    try {
      const r = await refuseQuotePublicAction(token, { reason })
      if (!r.ok) { toast.error(r.error); return }
      toast.success("Refus enregistré.")
      router.refresh()
    } catch { toast.error("Erreur serveur, réessayez.") } finally { setBusy(null) }
  }

  return (
    <form onSubmit={sign} className="space-y-3 rounded-lg border bg-white p-4">
      <h2 className="font-semibold">Signer ce devis</h2>
      <div><Label htmlFor="signer">Nom et prénom du signataire</Label><Input id="signer" required minLength={2} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></div>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" required checked={approved} onChange={(e) => setApproved(e.target.checked)} className="mt-1" /> Bon pour accord : j&apos;ai lu et j&apos;approuve ce devis, ses montants et ses conditions.</label>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy !== null || !approved || name.trim().length < 2}>{busy === "sign" && <Loader2 className="h-4 w-4 animate-spin" />} Signer et accepter</Button>
        <Button type="button" variant="outline" disabled={busy !== null} onClick={refuse}>{busy === "refuse" && <Loader2 className="h-4 w-4 animate-spin" />} Refuser</Button>
      </div>
      <p className="text-xs text-slate-500">La date, l&apos;heure et une empreinte technique de votre connexion sont enregistrées comme preuve d&apos;acceptation.</p>
    </form>
  )
}
