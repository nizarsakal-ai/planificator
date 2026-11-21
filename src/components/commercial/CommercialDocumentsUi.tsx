"use client"
// 21/11/2026 — composants interactifs des documents commerciaux (bons de commande clients, bons de livraison).
import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent } from "@/components/ui/card"
import { cancelClientOrderAction, cancelDeliveryNoteAction, createClientOrderAction, createDeliveryNoteAction, recordDeliveryReceiptAction } from "@/lib/actions/commercial-documents.actions"

/** Jour civil LOCAL (pas UTC : après minuit à Paris, toISOString donnerait la veille). */
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` }
const area = "mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"

/** Création d'un bon de commande client depuis un devis accepté (formulaire repliable). */
export function CreateClientOrderButton({ quoteId, defaultAddress }: { quoteId: string; defaultAddress: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [v, setV] = useState({ issueDate: today(), expectedDeliveryDate: "", deliveryAddress: defaultAddress, notes: "" })
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true)
    try {
      const r = await createClientOrderAction({ quoteId, ...v })
      if (!r.ok) { toast.error(r.error); return }
      toast.success(`Bon de commande ${r.number} créé.`)
      router.push(`/bons-de-commande/${r.id}`)
    } catch { toast.error("Erreur serveur.") } finally { setBusy(false) }
  }
  if (!open) return <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>Créer le bon de commande</Button>
  return (
    <Card className="w-full"><CardContent className="p-4">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <p className="text-sm font-medium text-slate-700 sm:col-span-2">Bon de commande client (lignes et montants repris du devis)</p>
        <div><Label htmlFor="co-date">Date</Label><Input id="co-date" type="date" required value={v.issueDate} onChange={(e) => setV({ ...v, issueDate: e.target.value })} /></div>
        <div><Label htmlFor="co-expected">Livraison prévue (facultatif)</Label><Input id="co-expected" type="date" value={v.expectedDeliveryDate} onChange={(e) => setV({ ...v, expectedDeliveryDate: e.target.value })} /></div>
        <div className="sm:col-span-2"><Label htmlFor="co-address">Adresse de livraison</Label><textarea id="co-address" rows={2} maxLength={500} className={area} value={v.deliveryAddress} onChange={(e) => setV({ ...v, deliveryAddress: e.target.value })} placeholder="Vide = adresse de livraison de la fiche client" /></div>
        <div className="sm:col-span-2"><Label htmlFor="co-notes">Notes (facultatif)</Label><textarea id="co-notes" rows={2} maxLength={2000} className={area} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></div>
        <div className="flex gap-2 sm:col-span-2"><Button type="submit" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Créer</Button><Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Annuler</Button></div>
      </form>
    </CardContent></Card>
  )
}

export function CancelClientOrderButton({ orderId }: { orderId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  async function cancel() {
    if (!window.confirm("Annuler ce bon de commande ? Il reste consultable (jamais supprimé).")) return
    setBusy(true)
    try { const r = await cancelClientOrderAction(orderId); if (!r.ok) toast.error(r.error); else { toast.success("Bon de commande annulé."); router.refresh() } } finally { setBusy(false) }
  }
  return <Button type="button" variant="outline" size="sm" onClick={cancel} disabled={busy}>Annuler le bon de commande</Button>
}

export interface DeliveryLine { designation: string; unit: string; quantity: string }

/** Création d'un bon de livraison : date, adresse, quantité livrée par ligne (vide = quantité commandée). */
export function DeliveryNoteForm({ sourceType, sourceId, label, defaultAddress, lines }: { sourceType: "QUOTE" | "INVOICE" | "CLIENT_ORDER"; sourceId: string; label: string; defaultAddress: string; lines: DeliveryLine[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [v, setV] = useState({ deliveryDate: today(), deliveryAddress: defaultAddress, notes: "" })
  const [delivered, setDelivered] = useState<string[]>(lines.map((l) => l.quantity))
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true)
    try {
      const r = await createDeliveryNoteAction({ sourceType, sourceId, ...v, delivered })
      if (!r.ok) { toast.error(r.error); return }
      toast.success(`Bon de livraison ${r.number} créé.`)
      router.push(`/bons-de-livraison/${r.id}`)
    } catch { toast.error("Erreur serveur.") } finally { setBusy(false) }
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <Card><CardContent className="grid gap-3 p-4 sm:grid-cols-2">
        <p className="text-sm text-slate-600 sm:col-span-2">Lignes reprises du {label}. Indiquez la quantité réellement livrée (livraison partielle possible : un autre bon pourra suivre).</p>
        <div><Label htmlFor="dn-date">Date de livraison</Label><Input id="dn-date" type="date" required value={v.deliveryDate} onChange={(e) => setV({ ...v, deliveryDate: e.target.value })} /></div>
        <div className="sm:col-span-2"><Label htmlFor="dn-address">Adresse de livraison</Label><textarea id="dn-address" rows={2} maxLength={500} className={area} value={v.deliveryAddress} onChange={(e) => setV({ ...v, deliveryAddress: e.target.value })} /></div>
        <div className="sm:col-span-2"><Label htmlFor="dn-notes">Notes (facultatif)</Label><textarea id="dn-notes" rows={2} maxLength={2000} className={area} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></div>
      </CardContent></Card>
      <Card><CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Désignation</th><th className="px-3 py-2">Unité</th><th className="px-3 py-2 text-right">Qté commandée</th><th className="px-3 py-2 text-right">Qté livrée</th></tr></thead>
          <tbody>{lines.map((l, i) => (
            <tr key={i} className="border-t"><td className="px-3 py-2">{l.designation}</td><td className="px-3 py-2">{l.unit}</td><td className="px-3 py-2 text-right tabular-nums">{l.quantity}</td>
              <td className="px-3 py-2 text-right"><Input aria-label={`Quantité livrée — ${l.designation}`} inputMode="decimal" className="ml-auto h-8 w-24 text-right" value={delivered[i]} onChange={(e) => setDelivered((d) => d.map((x, j) => (j === i ? e.target.value : x)))} /></td></tr>
          ))}</tbody>
        </table>
      </CardContent></Card>
      <div className="flex gap-2"><Button type="submit" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Créer le bon de livraison</Button><Button type="button" variant="ghost" onClick={() => router.back()} disabled={busy}>Retour</Button></div>
    </form>
  )
}

/** Réception et annulation d'un bon de livraison en attente. */
export function DeliveryNoteActions({ noteId }: { noteId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [v, setV] = useState({ receivedByName: "", receivedAt: today() })
  async function receipt(e: React.FormEvent) {
    e.preventDefault(); setBusy(true)
    try { const r = await recordDeliveryReceiptAction({ noteId, ...v }); if (!r.ok) toast.error(r.error); else { toast.success("Réception enregistrée."); router.refresh() } } finally { setBusy(false) }
  }
  async function cancel() {
    if (!window.confirm("Annuler ce bon de livraison ? Il reste consultable (jamais supprimé).")) return
    setBusy(true)
    try { const r = await cancelDeliveryNoteAction(noteId); if (!r.ok) toast.error(r.error); else { toast.success("Bon de livraison annulé."); router.refresh() } } finally { setBusy(false) }
  }
  return (
    <Card><CardContent className="space-y-3 p-4">
      <form onSubmit={receipt} className="flex flex-wrap items-end gap-2">
        <div><Label htmlFor="rc-name">Reçu par</Label><Input id="rc-name" required maxLength={120} value={v.receivedByName} onChange={(e) => setV({ ...v, receivedByName: e.target.value })} placeholder="Nom du destinataire" /></div>
        <div><Label htmlFor="rc-date">Le</Label><Input id="rc-date" type="date" required value={v.receivedAt} onChange={(e) => setV({ ...v, receivedAt: e.target.value })} /></div>
        <Button type="submit" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer la réception</Button>
        <Button type="button" variant="outline" onClick={cancel} disabled={busy}>Annuler le bon</Button>
      </form>
    </CardContent></Card>
  )
}
