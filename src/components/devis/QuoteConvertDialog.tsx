"use client"
// V2 06/11/2026 — « Créer la facture » depuis un devis, avec le numéro de bon de commande CLIENT (facultatif, jamais inventé).
// • Brouillon : explication des étapes (envoyer, puis enregistrer l'acceptation) ; aucune acceptation ni envoi automatique.
// • Envoyé : acceptation explicite d'abord (confirmation dédiée, sans affirmer de signature), puis l'étape facture.
// • Accepté (ou converti sans facture de solde) : saisie du bon de commande, récapitulatif, confirmation, ouverture du brouillon.
import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { convertQuoteAction, quoteStatusAction } from "@/lib/actions/quote.actions"
import { PO_REF_MAX, normalizePurchaseOrderRef } from "@/lib/billing/quotes/purchase-order-ref"

type Step = "explain" | "accept" | "convert"

export function QuoteConvertDialog({ quoteId, status, totalTTC, currentPoRef, depositsCount, reconvert = false }: {
  quoteId: string; status: string; totalTTC: string; currentPoRef: string | null; depositsCount: number; reconvert?: boolean
}) {
  const router = useRouter()
  const startStep: Step = status === "DRAFT" ? "explain" : status === "SENT" ? "accept" : "convert"
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>(startStep)
  const [loading, setLoading] = useState(false)
  const [poRef, setPoRef] = useState(currentPoRef ?? "")
  const po = normalizePurchaseOrderRef(poRef)

  async function accept() {
    setLoading(true)
    try {
      const r = await quoteStatusAction(quoteId, "ACCEPTED")
      if (!r.ok) { toast.error(r.error); return }
      toast.success("Acceptation du client enregistrée.")
      setStep("convert"); router.refresh()
    } catch { toast.error("Erreur serveur : acceptation non enregistrée.") } finally { setLoading(false) }
  }
  async function convert(e: React.FormEvent) {
    e.preventDefault()
    if (!po.ok) { toast.error(po.error); return }
    setLoading(true)
    try {
      const r = await convertQuoteAction(quoteId, po.value)
      if (!r.ok) { toast.error(r.error); return }
      if (r.existing) toast.info(`Facture déjà créée : ${r.invoiceNumber}${r.clientPurchaseOrderRef ? ` (bon de commande ${r.clientPurchaseOrderRef} conservé)` : ""}.`)
      else toast.success(`Facture ${r.invoiceNumber} créée (brouillon, non émise).`)
      setOpen(false); router.push(`/factures/${r.invoiceId}`); router.refresh()
    } catch { toast.error("Erreur serveur : facture non créée.") } finally { setLoading(false) }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) setStep(startStep) }}>
      <DialogTrigger asChild><Button size="sm" variant={status === "ACCEPTED" || reconvert ? "default" : "outline"}>{reconvert ? "Créer la facture de solde" : "Créer la facture"}</Button></DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Créer la facture depuis ce devis</DialogTitle>
          <DialogDescription>La facture est créée en brouillon : rien n&apos;est émis ni envoyé automatiquement.</DialogDescription>
        </DialogHeader>
        {step === "explain" && (
          <div className="space-y-3 text-sm">
            <p>Ce devis est un brouillon : il doit d&apos;abord être accepté par le client.</p>
            <ol className="list-decimal space-y-1 pl-5 text-slate-700">
              <li>Envoyez le devis au client (bouton « Envoyer au client »).</li>
              <li>Enregistrez son acceptation : signature en ligne par le client, ou « Marquer accepté » si vous avez reçu son accord.</li>
              <li>Revenez ici pour créer la facture avec le numéro de bon de commande du client.</li>
            </ol>
            <div className="flex justify-end"><Button type="button" variant="outline" onClick={() => setOpen(false)}>Fermer</Button></div>
          </div>
        )}
        {step === "accept" && (
          <div className="space-y-3 text-sm">
            <p>Ce devis est envoyé et attend la réponse du client. Pour le facturer, enregistrez d&apos;abord son acceptation.</p>
            <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-amber-800">À n&apos;utiliser que si le client a donné son accord (bon de commande, courrier, e-mail). Ce n&apos;est pas une signature en ligne.</p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Annuler</Button>
              <Button type="button" disabled={loading} onClick={() => void accept()}>{loading && <Loader2 className="h-4 w-4 animate-spin" />} Le client a accepté ce devis</Button>
            </div>
          </div>
        )}
        {step === "convert" && (
          <form onSubmit={convert} className="space-y-3 text-sm">
            <div>
              <Label htmlFor="po-ref">N° de bon de commande du client (facultatif)</Label>
              <Input id="po-ref" maxLength={PO_REF_MAX} autoComplete="off" value={poRef} onChange={(e) => setPoRef(e.target.value)} aria-invalid={!po.ok} />
              {!po.ok ? <p className="mt-1 text-xs text-red-600">{po.error}</p> : <p className="mt-1 text-xs text-slate-500">Recopiez le numéro figurant sur le bon de commande du client. Laissez vide si vous ne l&apos;avez pas : il pourra être ajouté sur le brouillon de facture. Ce n&apos;est ni le numéro de facture ni une commande fournisseur.</p>}
            </div>
            <div className="rounded-md bg-slate-50 p-3">
              <p className="font-medium text-slate-700">Repris dans la facture brouillon</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-slate-600">
                <li>Client, chantier, objet, lignes, remises, TVA et conditions du devis ({totalTTC} TTC)</li>
                <li>{depositsCount > 0 ? `Acomptes émis déduits automatiquement (${depositsCount})` : "Aucun acompte à déduire"}</li>
                <li>Numéro de facture définitif attribué seulement à l&apos;émission</li>
              </ul>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Annuler</Button>
              <Button type="submit" disabled={loading || !po.ok}>{loading && <Loader2 className="h-4 w-4 animate-spin" />} Créer la facture brouillon</Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
