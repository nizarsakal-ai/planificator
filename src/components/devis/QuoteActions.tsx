"use client"
import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { convertQuoteAction, deleteDraftQuoteAction, duplicateQuoteAction, quoteStatusAction, sendQuoteAction } from "@/lib/actions/quote.actions"

export function QuoteActions({ id, status, hasEmail, invoiceId }: { id: string; status: string; hasEmail: boolean; invoiceId: string | null }) {
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
  if (status === "DRAFT" || status === "SENT") {
    buttons.push(B("send", status === "DRAFT" ? "Envoyer au client" : "Renvoyer (nouveau lien)", () => {
      if (!hasEmail) { toast.error("Le client n'a pas d'adresse e-mail."); return }
      if (!window.confirm(status === "DRAFT" ? "Envoyer ce devis ? Il ne sera plus modifiable." : "Renvoyer le devis ? L'ancien lien de signature sera invalidé.")) return
      void act("send", () => sendQuoteAction(id), (r) => (r.status === "SENT" ? "Devis envoyé." : "Devis marqué envoyé (courrier simulé : envoi désactivé)."))
    }, "default"))
  }
  if (status === "SENT") {
    buttons.push(B("accept", "Marquer accepté", () => { if (window.confirm("Enregistrer l'acceptation du client (hors signature en ligne) ?")) void act("accept", () => quoteStatusAction(id, "ACCEPTED"), () => "Devis accepté.") }))
    buttons.push(B("refuse", "Refuser", () => { const reason = window.prompt("Motif du refus (facultatif) :", ""); if (reason !== null) void act("refuse", () => quoteStatusAction(id, "REFUSED", reason), () => "Devis refusé.") }))
  }
  if (status === "DRAFT" || status === "SENT") buttons.push(B("expire", "Expirer", () => { if (window.confirm("Marquer ce devis expiré ?")) void act("expire", () => quoteStatusAction(id, "EXPIRED"), () => "Devis expiré.") }))
  if (status === "ACCEPTED") buttons.push(B("convert", "Convertir en facture", () => { if (window.confirm("Créer la facture (brouillon) à partir de ce devis ?")) void act("convert", () => convertQuoteAction(id), (r) => (r.existing ? `Facture déjà créée : ${r.invoiceNumber}` : `Facture ${r.invoiceNumber} créée (brouillon).`), (r) => `/factures/${r.invoiceId}`) }, "default"))
  if (status === "CONVERTED" && invoiceId) buttons.push(<Button key="inv" size="sm" variant="outline" asChild><Link href={`/factures/${invoiceId}`}>Voir la facture</Link></Button>)
  buttons.push(B("dup", "Dupliquer", () => void act("dup", () => duplicateQuoteAction(id), (r) => `Devis ${r.number} créé.`, (r) => `/devis/${r.id}`)))
  buttons.push(<Button key="pdf" size="sm" variant="outline" asChild><a href={`/api/pdf/devis/${id}`} target="_blank" rel="noopener">PDF</a></Button>)
  if (status === "DRAFT") buttons.push(B("del", "Supprimer le brouillon", () => { if (window.confirm("Supprimer définitivement ce brouillon ?")) void act("del", () => deleteDraftQuoteAction(id), () => "Brouillon supprimé.", () => "/devis") }, "destructive"))
  return <div className="flex flex-wrap gap-2">{buttons}</div>
}
