// Lot E Planificator V2 (v7) : retour explicite des actions de formulaire (sans redirection serveur). Module ordinaire (pas
// « use server ») : type et aides partagés par crm.actions.ts, automation.actions.ts et le composant RetourFormulaire.
export type RetourAction = {
  /** "initial" : aucun envoi encore ; "ok" / "erreur" : résultat de la dernière action. */
  etat: "initial" | "ok" | "erreur"
  message: string
  /** Page à ouvrir après succès (création d'opportunité) ; absente : actualisation de la page courante. */
  cible?: string
  /** Instant serveur de la réponse (ms) : l'actualisation est appliquée quand la page est rendue après cet instant. */
  horodatage: number
}

export const RETOUR_INITIAL: RetourAction = { etat: "initial", message: "", horodatage: 0 }

export function retour(ok: boolean, message: string, cible?: string): RetourAction {
  return { etat: ok ? "ok" : "erreur", message, ...(cible ? { cible } : {}), horodatage: Date.now() }
}

/** useActionState appelle l'action avec (état précédent, formulaire) ; un envoi direct ne transmet que le formulaire. */
export function formulaireDe(a: RetourAction | FormData, b?: FormData): FormData {
  if (b instanceof FormData) return b
  if (a instanceof FormData) return a
  return new FormData()
}

// Correctif E4 (preuves e3y) : après un SUCCÈS, le client ouvre la page suivante par une navigation NATIVE du document
// (Post/Redirect/Get de V1, message « ?ok= » affiché par StockFlash), au lieu d'une transition du routeur client dont la
// validation pouvait rester suspendue. Adresses strictement limitées aux pages du lot E (aucune redirection ouverte).
/** Fiche d'une opportunité : seule cible admise après une création. */
const FICHE = /^\/crm\/opportunites\/[A-Za-z0-9_-]{1,64}$/
/** Pages du lot E pouvant être rouvertes après une action sans cible. */
const PAGES_LOT_E = /^\/(?:crm\/opportunites(?:\/[A-Za-z0-9_-]{1,64})?|automatisations)$/

/** Adresse relative à ouvrir après le résultat `r` d'une action envoyée depuis `cheminCourant` (pathname), ou null : pas de
 * navigation (erreur, état initial, adresse hors lot E). Le message n'est jamais interprété : il est encodé dans « ok ». */
export function adresseApresSucces(r: RetourAction, cheminCourant: string): string | null {
  if (r.etat !== "ok") return null
  const chemin = r.cible ?? cheminCourant
  if (!(r.cible ? FICHE : PAGES_LOT_E).test(chemin)) return null
  return `${chemin}?${new URLSearchParams({ ok: r.message }).toString()}`
}

// Correctif E4 (recette Mac E4-08) : document ouvert par l'historique (retour/avance), possiblement périmé.
/** Garde SYNCHRONE exécutée pendant l'analyse du document, pour la zone E rendue à l'instant serveur `rendu` : si CE document a
 * été ouvert par l'historique (navigation « back_forward » sur sa propre URL), l'instant est noté dans `window.__e4RenduHistorique`
 * et les envois de cette zone sont bloqués en capture (preventDefault + stopImmediatePropagation), avant React. AUCUNE mutation
 * du DOM (en particulier du sous-arbre React avant hydratation) : le bandeau est affiché par React à l'hydratation. Une revisite
 * ultérieure par le routeur client rend une zone d'un AUTRE instant : non visée. `rendu` est un nombre fini (aucun texte interpolé). */
export function gardeHistorique(rendu: number): string {
  const R = Number.isFinite(rendu) ? Math.trunc(rendu) : -1
  return `(function(){try{var R="${R}";var n=performance.getEntriesByType("navigation")[0];if(!n||n.type!=="back_forward")return;var u=new URL(n.name);if(u.pathname+u.search!==location.pathname+location.search)return;window.__e4RenduHistorique=Number(R);document.addEventListener("submit",function(e){var t=e.target,z=t&&t.closest&&t.closest("[data-zone-retour]");if(z&&z.getAttribute("data-rendu")===R){e.preventDefault();e.stopImmediatePropagation()}},true)}catch(e){}})()`
}
