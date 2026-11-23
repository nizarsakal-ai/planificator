/**
 * Cloche de notifications : comportement hors réseau (correctif ciblé).
 * - Hors réseau déclaré par le navigateur (`navigator.onLine === false`), l'action serveur de chargement n'est pas tentée.
 * - Au retour du réseau (événement `online`), le chargement est relancé ; l'écouteur est retiré au démontage.
 * - v3 : un ÉCHEC RÉSEAU du chargement (fetch rejeté avant toute réponse du serveur : TypeError aux messages connus des navigateurs) est
 *   absorbé, car `navigator.onLine` peut rester vrai pendant une coupure (nouveau document). Le chargement est retenté au retour du
 *   réseau ou à la prochaine ouverture. TOUTE AUTRE ERREUR (réponse du serveur, erreur de programmation, TypeError d'un autre message)
 *   reste rendue telle quelle, sans être masquée.
 */
export type EtatReseau = { onLine?: boolean } | null | undefined
export type CibleEvenements = Pick<EventTarget, "addEventListener" | "removeEventListener">

export function navigateurHorsLigne(nav: EtatReseau): boolean {
  return nav?.onLine === false
}

/** Messages d'échec réseau de fetch : Chromium, Firefox, WebKit. */
const MESSAGES_ECHEC_RESEAU = new Set(["Failed to fetch", "NetworkError when attempting to fetch resource.", "Load failed"])

/** Vrai seulement pour un rejet de fetch dû au réseau (aucune réponse du serveur). */
export function echecReseau(e: unknown): boolean {
  return e instanceof TypeError && MESSAGES_ECHEC_RESEAU.has(e.message)
}

/** Lance `charger` seulement si le navigateur ne se déclare pas hors réseau ; renvoie sa promesse, ou null. Un échec réseau est
 *  absorbé (la promesse se résout) ; tout autre rejet est rendu tel quel. */
export function chargerSiEnLigne(charger: () => Promise<void>, nav: EtatReseau): Promise<void> | null {
  if (navigateurHorsLigne(nav)) return null
  return charger().catch((e: unknown) => { if (echecReseau(e)) return; throw e })
}

/** Abonne `rappel` au retour du réseau ; renvoie la fonction de retrait (démontage). */
export function ecouterRetourReseau(cible: CibleEvenements, rappel: () => void): () => void {
  cible.addEventListener("online", rappel)
  return () => cible.removeEventListener("online", rappel)
}

/** DG02 : vrai SEULEMENT sur /dashboard quand le bootstrap next-pwa est actif (`window.workbox` posé par lui), lequel a
 *  installé AVANT le montage de React l'écouteur `online` qui recharge la page (`reloadOnOnline: true`, réglage global inchangé ; couplage
 *  verrouillé par test statique). Évalué AU MOMENT de l'événement. Build de développement ou sans PWA (pas de `window.workbox`) : faux,
 *  comportement inchangé. Aucun délai, aucune erreur interceptée : la relance est simplement laissée au document rechargé. */
export type FenetrePwa = { workbox?: unknown; location?: { pathname?: string } } | null | undefined
export function rechargementPwaSurDashboard(w: FenetrePwa): boolean {
  return !!w && w.workbox !== undefined && w.workbox !== null && w.location?.pathname === "/dashboard"
}
