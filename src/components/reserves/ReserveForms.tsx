"use client"
// Lot D (correctif « retour d'état ») : formulaires de réserve (création, levée, annulation) alimentés par useActionState,
// sans redirection vers la même page. Les états vivent dans le fournisseur, qui persiste : une ligne du tableau peut
// disparaître (réserve levée) sans perdre son message. Rendu identique : le message s'affiche au même endroit avec le
// même composant (StockFlash) ; l'URL reçoit `?ok=` / `?erreur=` par history.replaceState(null, …) (aucune requête) : le
// wrapper Next recopie __NA et synchronise son URL (ACTION_RESTORE). Sans JavaScript, `_retour` est absent : redirection.
// Extension PV : même retour d'état pour le procès-verbal ; la signature n'est remise à zéro qu'après un SUCCÈS (PV signé
// et figé), jamais après une erreur (refus, signature invalide, accès), où le tracé et son champ restent intacts.
import { createContext, useActionState, useContext, useEffect, useState, type ReactNode } from "react"
import { useSearchParams } from "next/navigation"
import { StockFlash } from "@/components/stock/StockFlash"
import { SignatureField } from "@/components/reserves/SignatureField"
import { cancelReserveFormAction, createReceptionReportFormAction, createReserveFormAction, liftReserveFormAction, type ReserveFormState } from "@/lib/actions/reserves.actions"

type Kind = "create" | "lift" | "cancel" | "report"
type Forms = { actions: Record<Kind, (form: FormData) => void>; hydrated: boolean; signedReports: number }
const FormsContext = createContext<Forms | null>(null)

function publish(state: ReserveFormState) {
  if (!state) return
  const url = new URL(window.location.href)
  url.searchParams.delete("ok")
  url.searchParams.delete("erreur")
  if ("ok" in state) url.searchParams.set("ok", state.ok)
  else url.searchParams.set("erreur", state.erreur)
  window.history.replaceState(null, "", url)   // pas history.state : son __NA court-circuiterait ACTION_RESTORE (Next 15.5.18)
}

export function ReserveFormsProvider({ children }: { children: ReactNode }) {
  const [created, create] = useActionState(createReserveFormAction, null)
  const [lifted, lift] = useActionState(liftReserveFormAction, null)
  const [cancelled, cancel] = useActionState(cancelReserveFormAction, null)
  const [reported, report] = useActionState(createReceptionReportFormAction, null)
  const [hydrated, setHydrated] = useState(false)
  const [signedReports, setSignedReports] = useState(0)   // nombre de PV signés avec succès dans cette page
  useEffect(() => { setHydrated(true) }, [])
  useEffect(() => { publish(created) }, [created])
  useEffect(() => { publish(lifted) }, [lifted])
  useEffect(() => { publish(cancelled) }, [cancelled])
  useEffect(() => { publish(reported); if (reported && "ok" in reported) setSignedReports((n) => n + 1) }, [reported])
  return <FormsContext.Provider value={{ actions: { create, lift, cancel, report }, hydrated, signedReports }}>{children}</FormsContext.Provider>
}

export function ReserveForm({ kind, className, children }: { kind: Kind; className?: string; children: ReactNode }) {
  const forms = useContext(FormsContext)
  if (!forms) throw new Error("ReserveForm hors de ReserveFormsProvider")
  return (
    <form action={forms.actions[kind]} className={className}>
      {forms.hydrated && <input type="hidden" name="_retour" value="etat" />}
      {children}
    </form>
  )
}

/** Signature du PV : remise à zéro à chaque PV signé avec succès (compteur), jamais après une erreur. */
export function ReportSignatureField({ label }: { label: string }) {
  const forms = useContext(FormsContext)
  if (!forms) throw new Error("ReportSignatureField hors de ReserveFormsProvider")
  return <SignatureField label={label} resetSignal={forms.signedReports} />
}

/** Message de la page (mêmes règles que StockFlash côté serveur : une valeur unique, affichée comme texte). */
export function ReserveFlash() {
  const params = useSearchParams()
  const one = (k: string) => { const v = params.getAll(k); return v.length === 0 ? undefined : v.length === 1 ? v[0] : v }
  return <StockFlash params={{ ok: one("ok"), erreur: one("erreur") }} />
}
