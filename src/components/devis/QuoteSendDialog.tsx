"use client"
// V2 06/11/2026 — dialogue d'envoi/renvoi d'un devis : le destinataire (nom et e-mail) est TOUJOURS affiché, modifiable et
// confirmé avant l'envoi. Propositions calculées côté serveur (buildRecipientSuggestions) ; aucun envoi sans clic de confirmation.
// 07/11/2026 (captures mobiles VM) : une adresse longue ne fait plus déborder le dialogue sur téléphone ; l'adresse reste COMPLÈTE et
// lisible (retour à la ligne n'importe où, min-w-0 sur les éléments de grille et de ligne, pied adaptable). Aucun changement métier.
import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { sendQuoteAction } from "@/lib/actions/quote.actions"
import { RECIPIENT_SOURCE_LABEL, normalizeEmail, type RecipientSource, type RecipientSuggestions } from "@/lib/billing/quotes/quote-recipient"

const IDENTIFICATION_TEXT: Record<RecipientSuggestions["identification"], string> = {
  LAST_SENT: "Destinataire du dernier envoi, modifiable.",
  CONSULTATION: "Contact identifié dans la demande d'origine.",
  NAME_ONLY: "Demandeur identifié par son nom : son adresse e-mail est à saisir.",
  SINGLE_KNOWN: "Aucun contact de demande identifié : contact connu proposé, à vérifier.",
  AMBIGUOUS: "Plusieurs contacts possibles : choisissez le destinataire ou saisissez-le.",
  ABSENT: "Aucun contact connu : saisissez le nom et l'adresse e-mail du destinataire.",
}

export function QuoteSendDialog({ quoteId, status, suggestions, disabled = false }: { quoteId: string; status: "DRAFT" | "SENT"; suggestions: RecipientSuggestions; disabled?: boolean }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const initial = suggestions.proposed
  const [choice, setChoice] = useState<string>(initial && initial.source !== "MANUAL" ? initial.email ?? "manual" : "manual")
  const [name, setName] = useState(initial?.name ?? "")
  const [email, setEmail] = useState(initial?.email ?? "")
  const [source, setSource] = useState<RecipientSource>(initial?.source ?? "MANUAL")
  // Observation C1 (revue Codex) : à CHAQUE ouverture, les champs repartent des propositions COURANTES (props rafraîchies par le
  // serveur après un envoi, un renvoi ou un changement de contact). Pendant que le dialogue est ouvert, la saisie n'est jamais écrasée.
  function resetFromProps() {
    const p = suggestions.proposed
    setChoice(p && p.source !== "MANUAL" ? p.email ?? "manual" : "manual")
    setName(p?.name ?? ""); setEmail(p?.email ?? ""); setSource(p?.source ?? "MANUAL")
  }

  function pick(value: string) {
    setChoice(value)
    if (value === "manual") { setSource("MANUAL"); return }
    const c = suggestions.candidates.find((x) => x.email === value)
    if (c) { setName(c.name ?? ""); setEmail(c.email); setSource(c.source) }
  }
  // Toute retouche manuelle d'un contact proposé devient une saisie manuelle (traçabilité de l'origine du choix).
  const edit = (patch: { name?: string; email?: string }) => {
    if (patch.name !== undefined) setName(patch.name)
    if (patch.email !== undefined) setEmail(patch.email)
    setChoice("manual"); setSource("MANUAL")
  }
  const normalized = normalizeEmail(email)
  const emailError = email.trim() && !normalized ? "Adresse e-mail invalide." : null

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!normalized) { toast.error("Indiquez une adresse e-mail valide."); return }
    setLoading(true)
    try {
      const r = await sendQuoteAction(quoteId, { name: name.trim() || null, email: normalized, source })
      if (!r.ok) { toast.error(r.error); return }
      toast.success(r.status === "SENT" ? `Devis envoyé à ${r.to}.` : `Devis marqué envoyé à ${r.to} (courrier simulé : envoi désactivé).`)
      setOpen(false); router.refresh()
    } catch { toast.error("Erreur serveur : devis non envoyé.") } finally { setLoading(false) }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (o && !open) resetFromProps(); setOpen(o) }}>
      <DialogTrigger asChild><Button size="sm" disabled={disabled}>{status === "DRAFT" ? "Envoyer au client" : "Renvoyer (nouveau lien)"}</Button></DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{status === "DRAFT" ? "Envoyer le devis" : "Renvoyer le devis"}</DialogTitle>
          <DialogDescription>{IDENTIFICATION_TEXT[suggestions.identification]}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="min-w-0 space-y-3 text-sm">
          {suggestions.candidates.length > 0 && (
            <fieldset className="space-y-1">
              <legend className="mb-1 font-medium text-slate-700">Contacts existants</legend>
              {suggestions.candidates.map((c) => (
                <label key={c.email} className="flex min-w-0 items-start gap-2">
                  <input type="radio" name="recipient" className="mt-1" checked={choice === c.email} onChange={() => pick(c.email)} />
                  <span className="min-w-0 [overflow-wrap:anywhere]"><span className="font-medium">{c.name ?? "(nom inconnu)"}</span> — {c.email}<br /><span className="text-xs text-slate-500">{RECIPIENT_SOURCE_LABEL[c.source]}</span></span>
                </label>
              ))}
              <label className="flex items-center gap-2"><input type="radio" name="recipient" checked={choice === "manual"} onChange={() => pick("manual")} /> Autre destinataire (saisie libre)</label>
            </fieldset>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="min-w-0"><Label htmlFor="rec-name">Nom du destinataire</Label><Input id="rec-name" maxLength={120} autoComplete="off" value={name} onChange={(e) => edit({ name: e.target.value })} /></div>
            <div className="min-w-0"><Label htmlFor="rec-email">E-mail du destinataire *</Label><Input id="rec-email" type="email" required maxLength={254} autoComplete="off" value={email} onChange={(e) => edit({ email: e.target.value })} aria-invalid={!!emailError} />{emailError && <p className="mt-1 text-xs text-red-600">{emailError}</p>}</div>
          </div>
          {suggestions.notices.length > 0 && <ul className="list-disc space-y-1 pl-5 text-xs text-slate-500">{suggestions.notices.map((n) => <li key={n}>{n}</li>)}</ul>}
          <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-amber-800">
            {status === "DRAFT" ? "Une fois envoyé, le devis ne sera plus modifiable." : "Le renvoi crée un nouveau lien de signature : l'ancien lien est invalidé."}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Annuler</Button>
            <Button type="submit" className="h-auto min-h-10 max-w-full whitespace-normal py-2 text-left [overflow-wrap:anywhere]" disabled={loading || !normalized}>{loading && <Loader2 className="h-4 w-4 animate-spin" />} {normalized ? `Envoyer à ${normalized}` : "Envoyer"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
