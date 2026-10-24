"use client"

import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Link2Off, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  listClientLinkedPartners,
  listPartnerReassignTargets,
  reassignClientPartner,
  type LinkedPartner,
  type ReassignTarget,
} from "@/lib/actions/client-partners.actions"

const DETACH = "__detach__"
const GENERIC_ERROR = "Action impossible. Veuillez réessayer."

/** Suffixe d'identifiant affiché pour distinguer deux fiches homonymes (jamais de ciblage par nom). */
export const shortId = (id: string) => `…${id.slice(-6)}`

interface Props {
  clientId: string
  /** Appelé quand la liste des partenaires liés change (vide ⇒ la suppression peut être retentée). */
  onChange?: (remaining: number) => void
  /** Désactive les actions pendant un appel serveur du parent. */
  disabled?: boolean
  /** Signale au parent qu'un appel serveur du panneau est en vol (début/fin), pour verrouiller son propre pied. */
  onBusyChange?: (busy: boolean) => void
}

/**
 * Panneau « partenaires d'acquisition liés » du dialogue de suppression d'un client.
 * Charge la liste côté serveur (bornée à l'entreprise), propose pour chaque partenaire une
 * réaffectation vers un autre client actif ou un détachement, puis recharge. Aucune suppression
 * de partenaire : le registre ne le permet pas.
 */
export function ClientLinkedPartnersPanel({ clientId, onChange, disabled, onBusyChange }: Props) {
  const [partners, setPartners] = useState<LinkedPartner[] | null>(null)
  const [targets, setTargets] = useState<ReassignTarget[]>([])
  const [choice, setChoice] = useState<Record<string, string>>({})
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const busy = useRef(false)

  const load = async () => {
    try {
      const [p, t] = await Promise.all([listClientLinkedPartners(clientId), listPartnerReassignTargets(clientId)])
      if ("error" in p) { setLoadError(p.error); setPartners([]); return }
      setPartners(p.partners)
      setTargets("error" in t ? [] : t.targets)
      setLoadError(null)
      onChange?.(p.partners.length)
    } catch {
      setLoadError(GENERIC_ERROR)
      setPartners([])
    }
  }

  useEffect(() => { void load() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  const apply = async (partner: LinkedPartner) => {
    if (busy.current) return
    const selected = choice[partner.id]
    if (!selected) return
    busy.current = true
    setPendingId(partner.id)
    onBusyChange?.(true)
    try {
      const target = selected === DETACH ? null : selected
      const result = await reassignClientPartner(partner.id, target)
      if ("error" in result) { toast.error(result.error); return }
      toast.success(target ? `Partenaire « ${partner.name} » réaffecté.` : `Partenaire « ${partner.name} » détaché.`)
      await load()
    } catch {
      toast.error(GENERIC_ERROR)
    } finally {
      busy.current = false
      setPendingId(null)
      onBusyChange?.(false)
    }
  }

  if (partners === null) {
    return <p className="text-xs text-slate-500">Recherche des partenaires liés…</p>
  }
  if (loadError) {
    return <p role="alert" className="text-xs text-red-600">{loadError}</p>
  }
  if (partners.length === 0) return null

  return (
    <section aria-label="Partenaires d'acquisition liés" className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3">
      <p className="text-sm font-medium text-amber-900">
        {partners.length} partenaire{partners.length > 1 ? "s" : ""} d&apos;acquisition lié{partners.length > 1 ? "s" : ""} à ce client
      </p>
      <p className="text-xs text-amber-800">
        Réaffectez chaque partenaire à un autre client actif, ou détachez-le, puis relancez la suppression.
        Un partenaire détaché n&apos;a plus de client déterministe pour ses consultations.
      </p>
      <ul className="space-y-2">
        {partners.map((partner) => {
          const isPending = pendingId === partner.id
          return (
            <li key={partner.id} className="flex flex-col gap-1.5 rounded border border-amber-200 bg-white p-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-slate-900">
                  {partner.name} <span className="text-xs font-normal text-slate-500">({partner.code} · {shortId(partner.id)})</span>
                </span>
                {!partner.active && <span className="text-xs text-slate-500">inactif</span>}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor={`reassign-${partner.id}`}>Réaffecter {partner.name} à</label>
                <select
                  id={`reassign-${partner.id}`}
                  className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs"
                  value={choice[partner.id] ?? ""}
                  disabled={disabled || isPending}
                  onChange={(e) => setChoice((c) => ({ ...c, [partner.id]: e.target.value }))}
                >
                  <option value="">Choisir une action…</option>
                  <option value={DETACH}>Détacher (aucun client)</option>
                  {targets.map((t) => (
                    <option key={t.id} value={t.id}>
                      Réaffecter à {t.name}{t.email ? ` · ${t.email}` : ""} · {shortId(t.id)}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled || isPending || !choice[partner.id]}
                  aria-busy={isPending}
                  onClick={() => apply(partner)}
                >
                  {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2Off className="h-4 w-4" />}
                  <span className="ml-1">Appliquer</span>
                </Button>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
