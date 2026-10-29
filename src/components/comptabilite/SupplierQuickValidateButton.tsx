"use client"
// Bouton « Valider » de la liste des factures fournisseurs : appelle directement l'action serveur existante, sans navigation ni boîte de
// confirmation (décision explicite au clic). Le compte de charge déjà enregistré est transmis comme confirmation d'imputation ; s'il manque
// ou si une règle métier bloque, la facture reste « À valider » et l'erreur s'affiche sous les actions avec un accès à la fiche « Vérifier ».
// Le composant englobe la rangée (badge + « Vérifier » fournis en enfants, puis « Valider ») afin que l'erreur soit un bloc borné SOUS la
// rangée, jamais dans la rangée `sm:flex-nowrap` (qui élargirait le tableau). Après succès, le bouton reste désactivé pendant le
// rafraîchissement (useTransition) puis jusqu'au remplacement de la ligne par son nouveau statut.
import { useMemo, useState, useTransition, type ReactNode } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { validateSupplierInvoiceAction } from "@/lib/actions/accounting-c5.actions"
import { createQuickValidator } from "./quick-validate"

export function SupplierQuickValidateButton({ id, expenseAccountId, ariaLabel, verifyHref, children }: { id: string; expenseAccountId: string | null; ariaLabel: string; verifyHref: string; children: ReactNode }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [refreshing, startRefresh] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const validator = useMemo(() => createQuickValidator({
    validate: () => validateSupplierInvoiceAction(id, expenseAccountId ?? undefined),
    refresh: () => startRefresh(() => router.refresh()),
    onBusyChange: setBusy,
    onSuccess: () => { setDone(true); setError(null); toast.success("Facture validée et comptabilisée.") },
    onError: (message) => { setError(message); toast.error(message) },
  }), [id, expenseAccountId, router])
  const locked = busy || done || refreshing
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:whitespace-nowrap">
        {children}
        <Button type="button" size="sm" disabled={locked} aria-busy={locked} aria-label={ariaLabel} className="h-auto min-h-8 py-1 leading-tight" onClick={() => { void validator.trigger() }}>
          {(busy || refreshing) && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />} Valider
        </Button>
      </div>
      {error && <p role="alert" className="max-w-[16rem] whitespace-normal text-xs leading-snug text-red-600">{error} <Link href={verifyHref} className="underline">Vérifier la facture</Link></p>}
    </div>
  )
}
