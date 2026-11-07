"use client"
import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { deleteDraftQuoteAction, duplicateQuoteAction, quoteStatusAction } from "@/lib/actions/quote.actions"
import type { RecipientSuggestions } from "@/lib/billing/quotes/quote-recipient"
import { QuoteSendDialog } from "@/components/devis/QuoteSendDialog"
import { QuoteConvertDialog } from "@/components/devis/QuoteConvertDialog"

// V2 06/11/2026 : envoi/renvoi via QuoteSendDialog (destinataire affiché, modifiable, confirmé) ; facturation via QuoteConvertDialog
// (étapes expliquées pour un brouillon, acceptation explicite, bon de commande client facultatif). Autres actions inchangées.
export function QuoteActions({ id, status, invoiceId, validityExpired = false, recipientSuggestions, totalTTC, purchaseOrderRef, depositsCount }: {
  id: string; status: string; invoiceId: string | null; validityExpired?: boolean
  recipientSuggestions: RecipientSuggestions | null; totalTTC: string; purchaseOrderRef: string | null; depositsCount: number
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)

  async function act(key: string, fn: () => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>, success: (r: Record<string, unknown>) => string, redirect?: (r: Record<string, unknown>) => string) {
    setBusy(key)
    try {
      const r = await fn()
      if (!r.ok) { toast.error(r.error ?? "Erreur"); return }
      toast.success(success(r))
      if (redirect) router.push(redirect(r))
      router.refresh()
    } catch { toast.error("Erreur serveur : action non effectuée.") } finally { setBusy(null) }
  }
  const B = (key: string, label: string, onClick: () => void, variant: "default" | "outline" | "destructive" | "secondary" = "outline") => (
    <Button key={key} size="sm" variant={variant} disabled={busy !== null} onClick={onClick}>{busy === key && <Loader2 className="h-4 w-4 animate-spin" />}{label}</Button>
  )

  const buttons: React.ReactNode[] = []
  if (status === "DRAFT") buttons.push(<Button key="edit" size="sm" variant="outline" asChild><Link href={`/devis/${id}/modifier`}>Modifier</Link></Button>)
  if ((status === "DRAFT" || status === "SENT") && !validityExpired && recipientSuggestions) {
    buttons.push(<QuoteSendDialog key="send" quoteId={id} status={status} suggestions={recipientSuggestions} disabled={busy !== null} />)
  }
  if (status === "SENT") {
    buttons.push(B("accept", "Marquer accepté", () => { if (window.confirm("Enregistrer l'acceptation du client (hors signature en ligne) ?")) void act("accept", () => quoteStatusAction(id, "ACCEPTED"), () => "Devis accepté.") }))
    buttons.push(B("refuse", "Refuser", () => { const reason = window.prompt("Motif du refus (facultatif) :", ""); if (reason !== null) void act("refuse", () => quoteStatusAction(id, "REFUSED", reason), () => "Devis refusé.") }))
  }
  if (status === "DRAFT" || status === "SENT") buttons.push(B("expire", "Expirer", () => { if (window.confirm("Marquer ce devis expiré ?")) void act("expire", () => quoteStatusAction(id, "EXPIRED"), () => "Devis expiré.") }))
  const convertProps = { quoteId: id, status, totalTTC, currentPoRef: purchaseOrderRef, depositsCount }
  if ((status === "DRAFT" || status === "SENT") && !validityExpired) buttons.push(<QuoteConvertDialog key="convert" {...convertProps} />)
  if (status === "ACCEPTED" && !invoiceId) buttons.push(<QuoteConvertDialog key="convert" {...convertProps} />)
  if ((status === "ACCEPTED" || status === "CONVERTED") && invoiceId) buttons.push(<Button key="inv" size="sm" variant="outline" asChild><Link href={`/factures/${invoiceId}`}>Voir la facture</Link></Button>)
  if (status === "CONVERTED" && !invoiceId) buttons.push(<QuoteConvertDialog key="reconvert" {...convertProps} reconvert />)
  buttons.push(B("dup", "Dupliquer", () => void act("dup", () => duplicateQuoteAction(id), (r) => `Devis ${r.number} créé.`, (r) => `/devis/${r.id}`)))
  buttons.push(<Button key="pdf" size="sm" variant="outline" asChild><a href={`/api/pdf/devis/${id}`} target="_blank" rel="noopener">PDF</a></Button>)
  if (status === "DRAFT") buttons.push(B("del", "Supprimer le brouillon", () => { if (window.confirm("Supprimer définitivement ce brouillon ?")) void act("del", () => deleteDraftQuoteAction(id), () => "Brouillon supprimé.", () => "/devis") }, "destructive"))
  return (
    <div className="space-y-2">
      {validityExpired && (status === "DRAFT" || status === "SENT") && <p className="text-sm text-amber-700">Validité dépassée : ce devis ne peut plus être envoyé ni signé (règle P2-04). Dupliquez-le pour renouveler l&apos;offre avec une nouvelle date de validité.</p>}
      <div className="flex flex-wrap gap-2">{buttons}</div>
    </div>
  )
}
