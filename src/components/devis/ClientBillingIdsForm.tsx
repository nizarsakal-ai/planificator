"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { saveClientBillingIdsAction } from "@/lib/actions/billing-settings.actions"

/** Identifiants de facturation du client (SIRET/SIREN, TVA intracommunautaire) — société de session uniquement. */
export function ClientBillingIdsForm({ clientId, siret, vatNumber }: { clientId: string; siret: string | null; vatNumber: string | null }) {
  const router = useRouter()
  const [v, setV] = useState({ siret: siret ?? "", vatNumber: vatNumber ?? "" })
  const [loading, setLoading] = useState(false)
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setLoading(true)
    try {
      const r = await saveClientBillingIdsAction({ clientId, ...v })
      if (!r.ok) { toast.error(r.error); return }
      toast.success("Identifiants du client enregistrés."); router.refresh()
    } catch { toast.error("Erreur serveur.") } finally { setLoading(false) }
  }
  return (
    <form onSubmit={submit} className="mt-2 flex flex-wrap items-end gap-2 text-xs">
      <label className="flex flex-col gap-1">SIRET / SIREN<Input className="h-8 w-40" value={v.siret} onChange={(e) => setV({ ...v, siret: e.target.value })} placeholder="14 chiffres" /></label>
      <label className="flex flex-col gap-1">TVA intracom.<Input className="h-8 w-36" value={v.vatNumber} onChange={(e) => setV({ ...v, vatNumber: e.target.value })} placeholder="FR…" /></label>
      <Button type="submit" size="sm" variant="outline" disabled={loading}>Enregistrer</Button>
    </form>
  )
}
