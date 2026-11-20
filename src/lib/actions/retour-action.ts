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
/** Lot F (recette Chrome v2) : page exacte du centre de connecteurs, rouverte après une action SANS cible (actualisation
 * seulement). Jamais une cible : la liste des fiches (FICHE) reste celle du pipeline commercial. */
const PAGES_LOT_F = /^\/connecteurs$/
/** Intégration FGHI v2 (incident Chrome) : page exacte de l'assistant (lot F), rouverte après une action SANS cible
 * (actualisation seulement), comme « /connecteurs ». Jamais une cible explicite. */
const PAGES_LOT_F_ASSISTANT = /^\/assistant$/

// Lot G Planificator V2 (portage sur ef36578f) : Document Studio, listes DISTINCTES (la liste FICHE du CRM est inchangée).
// Identifiants bornés (1 à 64 caractères sûrs) ; « documents » n'est jamais lu comme un identifiant de modèle.
// Espace PDF (lots 1 et 2, 20/11/2026) : fiche d'un PDF importé « /studio-documents/fichiers/<id> », même règle ; « fichiers »
// n'est jamais lu comme un identifiant de modèle ; la route de téléchargement (« …/revisions/<id> ») n'est jamais admise.
/** Cibles G calculées côté serveur : fiche d'un modèle (création), d'un document généré (génération) ou d'un PDF importé. */
const FICHES_LOT_G = /^\/studio-documents\/(?:(?:documents|fichiers)\/[A-Za-z0-9_-]{1,64}|(?!(?:documents|fichiers)$)[A-Za-z0-9_-]{1,64})$/
/** Pages G pouvant être rouvertes après une action sans cible : liste, modèle, document généré, PDF importé. */
const PAGES_LOT_G = /^\/studio-documents(?:\/(?:(?:documents|fichiers)\/[A-Za-z0-9_-]{1,64}|(?!(?:documents|fichiers)$)[A-Za-z0-9_-]{1,64}))?$/

// Lot H Planificator V2 (portage sur 90ae644) : pré-paie, liste DISTINCTE (FICHE du CRM et pages E inchangées).
/** Pages H, admises comme cible calculée côté serveur ou comme page rouverte : liste « /pre-paie » ou fiche d'une période
 * (identifiant borné de 1 à 64 caractères sûrs). L'export (« /pre-paie/<id>/export ») n'en fait jamais partie. */
const PAGES_LOT_H = /^\/pre-paie(?:\/[A-Za-z0-9_-]{1,64})?$/

// Lot I Planificator V2 : marketing et boutique, listes DISTINCTES (FICHE du CRM et pages E inchangées).
/** Cible I calculée côté serveur : fiche d'une commande boutique (identifiant borné). */
const FICHES_LOT_I = /^\/boutique\/commandes\/[A-Za-z0-9_-]{1,64}$/
/** Pages I rouvertes après une action sans cible : Marketing, Boutique, fiche d'une commande. */
const PAGES_LOT_I = /^\/(?:marketing|boutique(?:\/commandes\/[A-Za-z0-9_-]{1,64})?)$/

/** Adresse relative à ouvrir après le résultat `r` d'une action envoyée depuis `cheminCourant` (pathname), ou null : pas de
 * navigation (erreur, état initial, adresse hors lots E à I). Le message n'est jamais interprété : il est encodé dans « ok ».
 * Intégration FGHI : réunion EXACTE des listes de chaque lot, chacune inchangée. Cibles admises : fiche CRM (E), fiches G,
 * pages H, fiche de commande I ; jamais « /connecteurs » ni « /assistant » (F), ni une page E, ni « /marketing » ou
 * « /boutique » (I). Pages rouvertes sans cible : pages E, F (connecteurs, assistant), G, H et I. Exports, PDF et
 * adresses externes : jamais. */
export function adresseApresSucces(r: RetourAction, cheminCourant: string): string | null {
  if (r.etat !== "ok") return null
  const chemin = r.cible ?? cheminCourant
  const admis = r.cible
    ? FICHE.test(chemin) || FICHES_LOT_G.test(chemin) || PAGES_LOT_H.test(chemin) || FICHES_LOT_I.test(chemin)
    : PAGES_LOT_E.test(chemin) || PAGES_LOT_F.test(chemin) || PAGES_LOT_F_ASSISTANT.test(chemin) || PAGES_LOT_G.test(chemin) || PAGES_LOT_H.test(chemin) || PAGES_LOT_I.test(chemin)
  if (!admis) return null
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
