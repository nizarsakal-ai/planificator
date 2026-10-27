"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { autoReconcileAction, declareVatAction, matchTransactionAction, postMissingDocumentsAction, rejectSupplierInvoiceAction, resolveBankCollisionAction, resolveImportCollisionsAction, validateSupplierInvoiceAction } from "@/lib/actions/accounting-c5.actions"

function useAct() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  async function act<T extends { ok: boolean; error?: string }>(fn: () => Promise<T>, success: (r: T) => string) {
    setBusy(true)
    try { const r = await fn(); if (!r.ok) { toast.error(r.error ?? "Erreur"); return } toast.success(success(r)); router.refresh() }
    catch { toast.error("Erreur serveur : action non effectuée.") } finally { setBusy(false) }
  }
  return { busy, act }
}

export function PostMissingButton() {
  const { busy, act } = useAct()
  return <Button disabled={busy} onClick={() => void act(() => postMissingDocumentsAction(), (r) => (r.ok ? `${r.posted} écriture(s) générée(s), ${r.existing} déjà présente(s)${r.errors.length ? `, ${r.errors.length} erreur(s) : ${r.errors.slice(0, 3).map((e) => `${e.ref} (${e.error})`).join(" ; ")}` : ""}` : ""))}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Générer les écritures manquantes</Button>
}

export function DeclareVatButton({ periodStart, periodEnd, basis, blocked = false }: { periodStart: string; periodEnd: string; basis: string; blocked?: boolean }) {
  const { busy, act } = useAct()
  // R5 : la règle est appliquée côté serveur (declareVat refuse) ; le bouton l'annonce seulement.
  return <Button variant="outline" disabled={busy || blocked} title={blocked ? "Enregistrement refusé : situation hors contrat fiscal sur la période." : undefined} onClick={() => { if (window.confirm(`Enregistrer la déclaration de TVA du ${periodStart} au ${periodEnd} (${basis}) ? Les montants seront figés.`)) void act(() => declareVatAction({ periodStart, periodEnd, basis }), () => "Déclaration enregistrée.") }}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer la déclaration</Button>
}

export function AutoReconcileButton() {
  const { busy, act } = useAct()
  return <Button disabled={busy} onClick={() => void act(() => autoReconcileAction(), (r) => (r.ok ? `${r.matched} opération(s) rapprochée(s), ${r.unmatched} sans correspondance${r.errors.length ? `, ${r.errors.length} erreur(s)` : ""}` : ""))}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Rapprochement automatique</Button>
}

export function MatchButtons({ transactionId, invoices, supplierInvoices }: { transactionId: string; invoices: { id: string; number: string; label: string }[]; supplierInvoices: { id: string; number: string; label: string }[] }) {
  const { busy, act } = useAct()
  const [target, setTarget] = useState("")
  return (
    <div className="flex flex-wrap items-center gap-1">
      <select aria-label="Cible" value={target} onChange={(e) => setTarget(e.target.value)} className="h-8 max-w-xs rounded-md border border-input bg-background px-2 text-xs">
        <option value="">Rapprocher avec…</option>
        {invoices.map((i) => <option key={i.id} value={`inv:${i.id}`}>{i.number} — {i.label}</option>)}
        {supplierInvoices.map((s) => <option key={s.id} value={`sup:${s.id}`}>{s.number} — {s.label}</option>)}
      </select>
      <Button size="sm" variant="outline" disabled={busy || !target} onClick={() => void act(() => matchTransactionAction({ transactionId, ...(target.startsWith("inv:") ? { invoiceId: target.slice(4) } : { supplierInvoiceId: target.slice(4) }) }), () => "Opération rapprochée.")}>Valider</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { const notes = window.prompt("Ignorer cette opération ? Note (facultative) :", ""); if (notes !== null) void act(() => matchTransactionAction({ transactionId, ignore: true, notes }), () => "Opération ignorée.") }}>Ignorer</Button>
    </div>
  )
}

export function SupplierValidateButtons({ id }: { id: string }) {
  const { busy, act } = useAct()
  return (
    <div className="flex gap-2">
      <Button size="sm" disabled={busy} onClick={() => { if (window.confirm("Confirmez-vous avoir vérifié les montants, la catégorie et le compte de charge, y compris toute proposition OCR provisoire ? Cette facture sera figée et comptabilisée (journal HA).")) void act(() => validateSupplierInvoiceAction(id), () => "Facture validée et comptabilisée.") }}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Valider et comptabiliser</Button>
      <Button size="sm" variant="destructive" disabled={busy} onClick={() => { const r = window.prompt("Motif du rejet :", ""); if (r !== null) void act(() => rejectSupplierInvoiceAction(id, r), () => "Facture rejetée.") }}>Rejeter</Button>
    </div>
  )
}

/** R4 : collision d'identité inter-fichiers — décision explicite doublon / opération distincte (la règle est appliquée côté serveur). */
export function CollisionButtons({ transactionId, importId }: { transactionId: string; importId: string }) {
  const { busy, act } = useAct()
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => { if (window.confirm("Marquer cette opération comme DOUBLON de l'opération déjà importée ? Elle sera ignorée (aucun paiement).")) void act(() => resolveBankCollisionAction({ transactionId, resolution: "DUPLICATE" }), () => "Collision résolue : doublon ignoré.") }}>Doublon</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => { if (window.confirm("Confirmer qu'il s'agit d'une opération DISTINCTE (second mouvement réel) ? Elle deviendra rapprochable.")) void act(() => resolveBankCollisionAction({ transactionId, resolution: "DISTINCT" }), () => "Collision résolue : opération distincte.") }}>Opération distincte</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { if (window.confirm("Marquer comme DOUBLONS toutes les collisions non résolues de ce relevé ? (relevés qui se chevauchent)")) void act(() => resolveImportCollisionsAction({ importId, resolution: "DUPLICATE" }), (r) => (r.ok ? `${r.resolved} collision(s) du relevé résolue(s) en doublon.` : "")) }}>Tout le relevé : doublons</Button>
    </div>
  )
}
