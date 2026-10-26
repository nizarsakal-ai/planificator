"use client"
import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { issueInvoiceAction, reversePaymentAction, sendInvoiceAction, sendInvoiceReminderAction } from "@/lib/actions/invoice-c2.actions"
import { applyDepositDeductionsAction } from "@/lib/actions/deposit.actions"
import { createCreditNote, updateInvoiceStatus } from "@/lib/actions/invoice.actions"

type R = { ok: boolean; error?: string } & Record<string, unknown>

export function useBillingAction() {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  async function act(key: string, fn: () => Promise<R>, success: (r: R) => string, redirect?: (r: R) => string) {
    setBusy(key)
    try {
      const r = await fn()
      if (!r.ok) { toast.error(r.error ?? "Erreur"); return }
      toast.success(success(r)); if (redirect) router.push(redirect(r)); router.refresh()
    } catch { toast.error("Erreur serveur : action non effectuée.") } finally { setBusy(null) }
  }
  return { busy, act }
}

export function InvoiceActions({ id, status, kind, hasEmail, payable, hasQuote = false }: { id: string; status: string; kind: string; hasEmail: boolean; payable: boolean; hasQuote?: boolean }) {
  const { busy, act } = useBillingAction()
  const B = (key: string, label: string, onClick: () => void, variant: "default" | "outline" | "destructive" = "outline") => (
    <Button key={key} size="sm" variant={variant} disabled={busy !== null} onClick={onClick}>{busy === key && <Loader2 className="h-4 w-4 animate-spin" />}{label}</Button>
  )
  const buttons: React.ReactNode[] = []
  if (kind !== "CREDIT_NOTE") {
    if (status === "DRAFT") {
      if (kind === "INVOICE") buttons.push(<Button key="edit" size="sm" variant="outline" asChild><Link href={`/factures/${id}/modifier`}>Modifier</Link></Button>)
      if (kind === "INVOICE" && hasQuote) buttons.push(B("ded", "Recalculer les déductions d'acomptes", () => void act("ded", () => applyDepositDeductionsAction(id), (r) => `Déductions recalculées (${r.deposits} acompte${Number(r.deposits) > 1 ? "s" : ""}).`)))
      buttons.push(B("issue", "Émettre (numéroter)", () => { if (window.confirm("Émettre cette facture ? Un numéro légal définitif sera attribué et le contenu ne sera plus modifiable.")) void act("issue", () => issueInvoiceAction(id), (r) => `Facture ${r.number} émise.`) }, "default"))
      buttons.push(B("cancel", "Abandonner le brouillon", () => { if (window.confirm("Abandonner ce brouillon ? Il restera dans l'historique.")) void act("cancel", () => updateInvoiceStatus(id, "CANCELLED").then((r) => ("error" in r && r.error ? { ok: false, error: r.error } : { ok: true })), () => "Brouillon abandonné.") }, "destructive"))
    }
    if (status === "SENT" || status === "PARTIAL" || status === "PAID") {
      buttons.push(B("send", "Envoyer au client", () => { if (!hasEmail) { toast.error("Le client n'a pas d'adresse e-mail."); return } void act("send", () => sendInvoiceAction(id), (r) => (r.status === "SENT" ? "Facture envoyée." : "Courrier journalisé (envoi désactivé).")) }))
    }
    if (payable) buttons.push(B("remind", "Relancer", () => { if (!hasEmail) { toast.error("Le client n'a pas d'adresse e-mail."); return } void act("remind", () => sendInvoiceReminderAction(id), (r) => (r.status === "SENT" ? "Relance envoyée." : "Relance journalisée (envoi désactivé).")) }))
    if (status === "SENT" || status === "PARTIAL" || status === "PAID") {
      buttons.push(B("credit", "Avoir total (annulation)", () => { const reason = window.prompt("Émettre un avoir TOTAL : la facture passera à « annulée » (impossible si des avoirs partiels existent). Motif (facultatif) :", ""); if (reason !== null) void act("credit", () => createCreditNote(id, reason).then((r) => ("error" in r && r.error ? { ok: false, error: r.error } : { ok: true, number: (r as { number?: string }).number })), (r) => `Avoir ${r.number} émis.`) }))
    }
  }
  buttons.push(<Button key="pdf" size="sm" variant="outline" asChild><a href={`/api/pdf/facture/${id}`} target="_blank" rel="noopener">PDF</a></Button>)
  return <div className="flex flex-wrap gap-2">{buttons}</div>
}

export function ReversePaymentButton({ paymentId }: { paymentId: string }) {
  const { busy, act } = useBillingAction()
  return (
    <button type="button" disabled={busy !== null} className="text-xs text-red-600 hover:underline disabled:opacity-50"
      onClick={() => { const reason = window.prompt("Annuler ce paiement (contre-passation) ? Motif :", ""); if (reason !== null) void act("rev", () => reversePaymentAction(paymentId, reason), () => "Paiement annulé.") }}>
      {busy === "rev" ? "…" : "Annuler"}
    </button>
  )
}
