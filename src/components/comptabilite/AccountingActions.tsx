"use client"
// Petites actions du module Comptabilité (appels de Server Actions, retours via toast).
import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  advanceFiscalYearAction, createAccountAction, deleteDraftAction, initializeAccountingAction, openFiscalYearAction,
  postEntryAction, reverseEntryAction, setAccountActiveAction,
} from "@/lib/accounting/actions/accounting.actions"

type AnyResult = { ok: true } | { ok: false; error: string }

function useRunner() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  async function run<T extends AnyResult>(fn: () => Promise<T>, success: string | ((r: T) => string)): Promise<T | null> {
    setBusy(true)
    try {
      const r = await fn()
      if (!r.ok) { toast.error((r as { error: string }).error); return r }
      toast.success(typeof success === "function" ? success(r) : success)
      router.refresh()
      return r
    } catch {
      toast.error("Erreur serveur : action non effectuée.")
      return null
    } finally { setBusy(false) }
  }
  return { busy, run }
}

export function InitAccountingButton() {
  const { busy, run } = useRunner()
  return (
    <Button disabled={busy} onClick={() => run(() => initializeAccountingAction(), "Plan comptable et journaux initialisés.")}>
      {busy && <Loader2 className="animate-spin" />} Initialiser le plan comptable et les journaux
    </Button>
  )
}

export function OpenFiscalYearForm({ defaultStart, defaultEnd }: { defaultStart: string; defaultEnd: string }) {
  const { busy, run } = useRunner()
  const [start, setStart] = useState(defaultStart)
  const [end, setEnd] = useState(defaultEnd)
  return (
    <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); run(() => openFiscalYearAction({ startDate: start, endDate: end }), "Exercice ouvert.") }}>
      <div className="space-y-1"><Label htmlFor="fy-start">Début</Label><Input id="fy-start" type="date" required value={start} onChange={(e) => setStart(e.target.value)} /></div>
      <div className="space-y-1"><Label htmlFor="fy-end">Fin</Label><Input id="fy-end" type="date" required value={end} onChange={(e) => setEnd(e.target.value)} /></div>
      <Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />} Ouvrir l&apos;exercice</Button>
    </form>
  )
}

export function AdvanceFiscalYearButton({ fiscalYearId, to }: { fiscalYearId: string; to: "CLOSING" | "CLOSED" }) {
  const { busy, run } = useRunner()
  async function onClick() {
    if (to === "CLOSING") {
      if (!window.confirm("Passer l'exercice en clôture ? Seules les OD de clôture pourront encore être validées.")) return
      await run(() => advanceFiscalYearAction({ fiscalYearId, to, confirmation: "" }), "Exercice en clôture.")
    } else {
      const typed = window.prompt("Clôture DÉFINITIVE : plus aucune écriture ne pourra être validée sur cet exercice. Tapez CLÔTURER pour confirmer.")
      if (typed === null) return
      await run(() => advanceFiscalYearAction({ fiscalYearId, to, confirmation: typed.trim() }), "Exercice clôturé.")
    }
  }
  return (
    <Button size="sm" variant={to === "CLOSED" ? "destructive" : "outline"} disabled={busy} onClick={onClick}>
      {busy && <Loader2 className="animate-spin" />} {to === "CLOSING" ? "Passer en clôture" : "Clôturer"}
    </Button>
  )
}

export function NewAccountForm() {
  const { busy, run } = useRunner()
  const [number, setNumber] = useState("")
  const [label, setLabel] = useState("")
  return (
    <form className="flex flex-wrap items-end gap-3" onSubmit={async (e) => {
      e.preventDefault()
      const r = await run(() => createAccountAction({ number, label }), "Compte créé.")
      if (r?.ok) { setNumber(""); setLabel("") }
    }}>
      <div className="space-y-1"><Label htmlFor="acc-number">Numéro</Label><Input id="acc-number" inputMode="numeric" required maxLength={10} className="w-32" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="622600" /></div>
      <div className="min-w-[14rem] flex-1 space-y-1"><Label htmlFor="acc-label">Libellé</Label><Input id="acc-label" required maxLength={200} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Honoraires" /></div>
      <Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />} Ajouter</Button>
    </form>
  )
}

export function AccountActiveToggle({ accountId, active }: { accountId: string; active: boolean }) {
  const { busy, run } = useRunner()
  return (
    <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => setAccountActiveAction({ accountId, active: !active }), active ? "Compte désactivé." : "Compte activé.")}>
      {busy && <Loader2 className="animate-spin" />} {active ? "Désactiver" : "Activer"}
    </Button>
  )
}

export function DraftEntryActions({ entryId }: { entryId: string }) {
  const { busy, run } = useRunner()
  const router = useRouter()
  return (
    <div className="flex flex-wrap gap-2">
      <Button disabled={busy} onClick={() => {
        if (!window.confirm("Valider cette écriture ? Elle sera numérotée et ne pourra plus être modifiée ni supprimée.")) return
        run(() => postEntryAction(entryId), (r) => `Écriture validée (n° ${(r as { number: number }).number}).`)
      }}>{busy && <Loader2 className="animate-spin" />} Valider</Button>
      <Button variant="outline" disabled={busy} onClick={async () => {
        if (!window.confirm("Supprimer ce brouillon ?")) return
        const r = await run(() => deleteDraftAction(entryId), "Brouillon supprimé.")
        if (r?.ok) router.push("/comptabilite/ecritures")
      }}>Supprimer le brouillon</Button>
    </div>
  )
}

export function ReverseEntryForm({ entryId, years, defaultYearId, defaultDate }: {
  entryId: string; years: { id: string; label: string }[]; defaultYearId: string; defaultDate: string
}) {
  const { busy, run } = useRunner()
  const router = useRouter()
  const [yearId, setYearId] = useState(defaultYearId)
  const [date, setDate] = useState(defaultDate)
  return (
    <form className="flex flex-wrap items-end gap-3" onSubmit={async (e) => {
      e.preventDefault()
      if (!window.confirm("Créer et valider la contre-passation (écriture miroir) ?")) return
      const r = await run(() => reverseEntryAction({ entryId, entryDate: date, fiscalYearId: yearId }), (x) => `Contre-passation validée (n° ${(x as { number: number }).number}).`)
      if (r?.ok) router.push(`/comptabilite/ecritures/${(r as unknown as { id: string }).id}`)
    }}>
      <div className="space-y-1"><Label htmlFor="rev-year">Exercice</Label>
        <select id="rev-year" className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={yearId} onChange={(e) => setYearId(e.target.value)}>
          {years.map((y) => <option key={y.id} value={y.id}>{y.label}</option>)}
        </select>
      </div>
      <div className="space-y-1"><Label htmlFor="rev-date">Date</Label><Input id="rev-date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></div>
      <Button type="submit" variant="outline" disabled={busy}>{busy && <Loader2 className="animate-spin" />} Contre-passer</Button>
    </form>
  )
}
