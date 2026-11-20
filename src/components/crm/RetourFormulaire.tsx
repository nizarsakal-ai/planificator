"use client"
// Lot E Planificator V2 : retour EXPLICITE des formulaires du pipeline commercial et des automatisations.
// Chaque formulaire passe par useActionState : une ERREUR reste affichée sur place, à l'emplacement habituel du message de
// retour (mêmes classes que StockFlash), sans navigation. Correctif E4 (preuves e3y) : après un SUCCÈS, la page suivante (fiche
// créée, ou page courante) est ouverte par une navigation NATIVE du document (window.location.assign), déclenchée dès la
// réponse de l'action, avant tout rendu React : le parcours ne dépend plus de la validation d'une transition du routeur client
// (router.push / router.refresh), qui pouvait rester suspendue. Aucun délai, aucun minuteur, aucun rechargement automatique.
// Le message de succès est porté par « ?ok= » et affiché par StockFlash comme en V1.
//
// Garde-fous (revue anticipée E4) :
//  - AVANT l'hydratation, les formulaires E sont DÉSACTIVÉS (fieldset disabled jusqu'au montage client ; choix d'implémentation
//    de Claude du 17/11, après la recette Mac E4-14) : l'envoi natif d'une action serveur avant hydratation menait à une réponse
//    inexploitable. JavaScript intégralement coupé n'est PAS pris en charge (réserve) : le flux Next masque alors la page.
//    Un clic avant hydratation est donc impossible et visible (bouton grisé), sans requête ni mutation perdue. L'action
//    serveur reste l'`action` du formulaire (défense si le montage échoue après coup) ;
//  - une fois hydraté, un seul envoi à la fois pour la page, décidé À LA SOUMISSION (onSubmit, synchrone) : un envoi non admis
//    (autre envoi en cours, page suivante en cours d'ouverture, page restaurée, mutation déjà faite) n'est pas transmis et le
//    refus est affiché ; une interruption de transport est signalée comme résultat inconnu (jamais comme un succès) ;
//  - si assign() lève, la page n'est PAS verrouillée en bloc, mais le formulaire dont la mutation a réussi est neutralisé
//    (aucun second envoi de la même mutation) et un lien de secours explicite est affiché ;
//  - document de l'HISTORIQUE (retour/avance du navigateur), qu'il soit restauré du bfcache (pageshow.persisted) OU rechargé
//    (navigation « back_forward ») : constat recette Mac E4-08, Chrome headless, navigation.type=back_forward, persisted=false,
//    liste « étape » restaurée à la saisie non envoyée (PROPOSAL) ET valeur serveur du document périmée (LEAD) alors que la base
//    dit QUALIFIED. Un tel document n'est donc jamais présenté comme à jour : bandeau « Page rouverte depuis l'historique » avec
//    lien « Actualiser la page » (navigation normale, données fraîches), et TOUS ses formulaires neutralisés :
//      · AVANT l'hydratation, formulaires désactivés (voir plus haut) et script synchrone de la page (garde en capture sur
//        « submit », preventDefault, SANS mutation du DOM), limité à la zone de CE document (instant de rendu serveur) : une
//        revisite par le routeur client (autre instant) n'est pas visée ; le bandeau est rendu par React à l'hydratation ;
//      · APRÈS l'hydratation, par le verrou figé (refus avant tout appel de mutation).
//    Aucune remise à zéro (form.reset ramènerait la valeur périmée du serveur), aucun rechargement automatique. Les formulaires
//    portent aussi autocomplete="off" (pas d'enregistrement de leur saisie par le navigateur).
import { createContext, useActionState, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react"
import { usePathname } from "next/navigation"
import { RETOUR_INITIAL, gardeHistorique, adresseApresSucces, type RetourAction } from "@/lib/actions/retour-action"

/** Zone rendue à l'instant `rendu` = celle du document ouvert par l'historique (notée par la garde synchrone), et non une
 * revisite ultérieure par le routeur client (autre instant de rendu serveur). */
function zoneDeLHistorique(rendu: number | undefined): boolean {
  const note = (window as unknown as { __e4RenduHistorique?: number }).__e4RenduHistorique
  return typeof rendu === "number" && Number.isFinite(rendu) && note === Math.trunc(rendu)
}

/** Page suivante après un succès. `echec` : la navigation native n'a pas pu être lancée (lien de secours seul). */
type Ouverture = { adresse: string; fiche: boolean; echec: boolean }
type Verrou = { prendre: () => boolean; rendre: () => void; figer: () => void }
type Zone = { dernier: RetourAction | null; ouverture: Ouverture | null; restauree: boolean; refus: number; publier: (r: RetourAction, o: Ouverture | null) => void; refuser: () => void; verrou: Verrou }
const ContexteRetour = createContext<Zone | null>(null)

/** Enveloppe d'une page du lot E. `rendu` : instant serveur du rendu (identifie la zone du document d'origine pour la garde). */
export function ZoneRetour({ rendu, children }: { rendu?: number; children: ReactNode }) {
  const [dernier, setDernier] = useState<RetourAction | null>(null)
  const [ouverture, setOuverture] = useState<Ouverture | null>(null)
  const [restauree, setRestauree] = useState(false)
  const [refus, setRefus] = useState(0)
  const refuser = useCallback(() => setRefus((n) => n + 1), [])
  // Réf. et non état : la décision d'envoyer ne dépend d'aucun rendu React. « fige » : plus aucun envoi sur cette page.
  const occupe = useRef(false)
  const fige = useRef(false)
  const [verrou] = useState<Verrou>(() => ({
    prendre: () => (fige.current || occupe.current ? false : (occupe.current = true)),
    rendre: () => { occupe.current = false },
    figer: () => { fige.current = true },
  }))
  const publier = useCallback((r: RetourAction, o: Ouverture | null) => {
    setDernier(r)
    setRefus(0)   // nouveau résultat reçu : l'éventuel refus précédent n'est plus d'actualité
    // Seul un succès ouvre (ou remplace) une ouverture ; une erreur ne l'efface jamais.
    if (o) setOuverture(o)
  }, [])
  useEffect(() => {
    // Document de l'historique (bfcache OU rechargé) : contenu possiblement périmé. Rien n'est masqué : la page le signale et
    // n'envoie plus rien ; l'utilisateur l'actualise par un lien explicite (aucun rechargement automatique).
    if (zoneDeLHistorique(rendu)) { verrou.figer(); setRestauree(true) }
    const reprise = (e: PageTransitionEvent) => { if (e.persisted) { verrou.figer(); setRestauree(true) } }
    window.addEventListener("pageshow", reprise)
    return () => window.removeEventListener("pageshow", reprise)
  }, [verrou, rendu])
  const instant = typeof rendu === "number" && Number.isFinite(rendu) ? Math.trunc(rendu) : -1
  return (
    <ContexteRetour.Provider value={{ dernier, ouverture, restauree, refus, publier, refuser, verrou }}>
      <script dangerouslySetInnerHTML={{ __html: gardeHistorique(instant) }} />
      <div data-zone-retour="" data-rendu={String(instant)} className="contents">{children}</div>
    </ContexteRetour.Provider>
  )
}

/** Message de la dernière action, placé là où la page affichait le message de retour. `children` : message issu de l'URL
 * (StockFlash), affiché tant qu'aucun RÉSULTAT d'action n'a été reçu depuis ce rendu ; il reste donc visible pendant la première
 * requête, puis les deux retours sont exclusifs. */
export function MessageRetour({ children }: { children?: ReactNode }) {
  const zone = useContext(ContexteRetour)
  const chemin = usePathname()
  // Bandeau toujours rendu, masqué tant que la zone n'est pas reconnue comme issue de l'historique (affiché par l'état React).
  const bandeau = (
    <p role="alert" data-retour="restauree" hidden={!zone?.restauree} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
      Page rouverte depuis l&apos;historique : ses données peuvent ne plus être à jour et ses formulaires sont désactivés.{" "}
      <a href={chemin} className="font-medium underline">Actualiser la page</a>
    </p>
  )
  if (zone?.restauree) return bandeau
  const r = zone?.dernier
  const o = zone?.ouverture
  const refus = zone && zone.refus > 0
    ? <p role="status" data-retour="refus" className="text-xs text-slate-500">Envoi non transmis : une opération de cette page est déjà en cours ou enregistrée.</p>
    : null
  if (!zone || !r || r.etat === "initial") return <>{bandeau}{children}{refus}</>
  return (
    <>
      {bandeau}
      {refus}
      {r.etat === "erreur"
        ? <p role="alert" data-retour="erreur" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{r.message}</p>
        : <p role="status" data-retour="ok" className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">{r.message}</p>}
      {o && !o.echec && (
        <p data-actualisation="en-cours" aria-live="polite" className="text-xs text-slate-500">
          {o.fiche ? "Ouverture de la fiche en cours… " : "Actualisation des données en cours… "}
          <a href={o.adresse} className="text-[#0f3460] hover:underline">{o.fiche ? "Ouvrir la fiche" : "Actualiser"}</a>
        </p>
      )}
      {o && o.echec && (
        <p role="alert" data-actualisation="echec" className="text-xs text-slate-500">
          {o.fiche ? "La fiche n'a pas pu être ouverte automatiquement. " : "La page n'a pas pu être actualisée automatiquement. "}
          <a href={o.adresse} className="font-medium text-[#0f3460] hover:underline">{o.fiche ? "Ouvrir la fiche" : "Actualiser"}</a>
        </p>
      )}
    </>
  )
}

/** Formulaire du lot E :
 *  - AVANT l'hydratation : formulaire DÉSACTIVÉ (fieldset), aucun envoi possible depuis l'interface. JavaScript intégralement
 *    coupé : non pris en charge (le flux Next masque la page). `action` reste l'action SERVEUR (useActionState) uniquement en
 *    défense : un POST natif forcé est traité par le serveur, qui rend le résultat dans le formulaire (message, lien de la fiche) ;
 *  - UNE FOIS HYDRATÉ : `onSubmit` prend la main (preventDefault : React n'appelle plus l'action du formulaire), décide
 *    l'admission (verrou de page), appelle l'action, puis ouvre la page suivante par navigation native dès la réponse. */
export function FormulaireRetour({ action, className, children }: { action: (etat: RetourAction, form: FormData) => Promise<RetourAction>; className?: string; children: ReactNode }) {
  const zone = useContext(ContexteRetour)
  const chemin = usePathname()
  const publier = zone?.publier
  const verrou = zone?.verrou
  const refuser = zone?.refuser
  // Page rouverte depuis l'historique : formulaire désactivé ET expliqué sur place (le bandeau de MessageRetour peut être hors
  // de vue, en haut d'une longue page : sans ce rappel, un clic sur le bouton semblait ne rien faire).
  const restauree = !!zone?.restauree
  // Envoi de CE formulaire refusé (opération en cours ou déjà enregistrée) : dit à côté du bouton, pas seulement en haut de page.
  const [refuseIci, setRefuseIci] = useState(false)
  // Mutation de CE formulaire réussie sans que la page suivante ait pu être ouverte : aucun nouvel envoi de ce formulaire.
  const consomme = useRef(false)
  const precedent = useRef<RetourAction>(RETOUR_INITIAL)
  // Défense (POST natif forcé, hors interface) : le résultat est RENDU PAR LE SERVEUR dans le formulaire même (mêmes
  // classes que le message de retour), sans dépendre d'un effet client ; une création réussie neutralise le formulaire dès ce
  // rendu (fieldset désactivé, « display: contents » : mise en page inchangée) et propose le lien de la fiche.
  const [etatNatif, envoyerNatif] = useActionState(action, RETOUR_INITIAL)
  // Monté côté client (hydraté) : seul état où le formulaire est utilisable.
  const [monte, setMonte] = useState(false)
  useEffect(() => { setMonte(true) }, [])
  const natifCree = etatNatif.etat === "ok" && !!etatNatif.cible
  const ficheNative = natifCree && etatNatif.cible && /^\/crm\/opportunites\/[A-Za-z0-9_-]{1,64}$/.test(etatNatif.cible) ? etatNatif.cible : null
  useEffect(() => { if (etatNatif.etat !== "initial") precedent.current = etatNatif }, [etatNatif])

  const envoyer = useCallback(async (form: FormData) => {
    let garder = false
    try {
      const r = await action(precedent.current, form)
      precedent.current = r
      const adresse = adresseApresSucces(r, window.location.pathname)
      if (!adresse) { publier?.(r, null); return }
      try {
        // Navigation native immédiate, sans attendre de rendu React : le document cible est rendu par le serveur.
        window.location.assign(adresse)
        garder = true   // page en cours de remplacement : verrou conservé
        publier?.(r, { adresse, fiche: !!r.cible, echec: false })
      } catch {
        consomme.current = true   // la mutation a réussi : ne jamais la renvoyer depuis ce formulaire
        publier?.(r, { adresse, fiche: !!r.cible, echec: true })
      }
    } catch {
      // Transport interrompu : résultat inconnu, dit tel quel (aucun faux succès) ; le verrou est rendu.
      publier?.({ etat: "erreur", message: "Envoi interrompu : résultat inconnu. Actualisez la page pour vérifier avant de réessayer.", horodatage: Date.now() }, null)
    } finally {
      if (!garder) verrou?.rendre()
    }
  }, [action, publier, verrou])

  // Admission À LA SOUMISSION (synchrone) : un envoi refusé n'est jamais transmis ; le refus est affiché.
  const soumettre = useCallback((e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (natifCree || consomme.current || (verrou && !verrou.prendre())) { refuser?.(); setRefuseIci(true); return }
    setRefuseIci(false)
    const soumetteur = (e.nativeEvent as SubmitEvent).submitter
    void envoyer(new FormData(e.currentTarget, soumetteur instanceof HTMLElement ? soumetteur : null))
  }, [envoyer, verrou, refuser, natifCree])
  const local = restauree
    ? <p role="alert" data-retour="restauree-local" className="col-span-full w-full rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
        Formulaire désactivé : page rouverte depuis l&apos;historique. <a href={chemin} className="font-medium underline">Actualiser la page</a>
      </p>
    : refuseIci
      ? <p role="status" data-retour="refus-local" className="col-span-full w-full text-xs text-slate-500">Envoi non transmis : une opération de cette page est déjà en cours ou enregistrée.</p>
      : null
  return (
    <form action={envoyerNatif} onSubmit={soumettre} autoComplete="off" className={className}>
      {etatNatif.etat !== "initial" && (
        <p role={etatNatif.etat === "erreur" ? "alert" : "status"} data-retour={etatNatif.etat === "erreur" ? "erreur-natif" : "ok-natif"}
          className={`col-span-full w-full rounded-lg border px-3 py-2 text-sm ${etatNatif.etat === "erreur" ? "border-red-200 bg-red-50 text-red-700" : "border-green-200 bg-green-50 text-green-700"}`}>
          {etatNatif.message}{ficheNative && <> <a href={ficheNative} className="font-medium underline">Ouvrir la fiche</a></>}
        </p>
      )}
      {local}
      <fieldset disabled={!monte || natifCree || restauree} data-hydrate={monte ? "oui" : "non"} className="contents">{children}</fieldset>
    </form>
  )
}
