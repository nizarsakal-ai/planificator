/**
 * Lot D — garde À LA SOURCE contre la mise en cache, hors routeur du service worker, des pages privées D.
 *
 * Le cache de navigation front-end de next-pwa (worker dédié « swe-worker-<empreinte>.js », message __FRONTEND_NAV_CACHE__)
 * lit chaque URL poussée dans l'historique par un fetch() émis DEPUIS CE WORKER, puis l'écrit directement dans le cache « pages »
 * si la réponse est ok (`if (!s.ok) return`), sans passer par les règles du SW. Un fetch émis par un worker dédié porte en
 * Referer l'URL du script du worker (référent « client » = URL de création du worker ; aucune Referrer-Policy globale dans
 * l'application), avec `Sec-Fetch-Dest: empty` et sans en-tête RSC.
 *
 * Seule cette requête est refusée (403, corps vide, `no-store`) : l'écriture est empêchée quel que soit son moment et que le
 * worker soit contrôlé ou non par le SW. Toute autre lecture d'une page D est inchangée : navigations de document, flux RSC
 * et préchargements du routeur, actions serveur (POST), et fetch émis par une page (référent = la page), y compris ceux qui
 * observent l'invalidation de session ou le transport réseau.
 *
 * Portée : pages D uniquement (/reserves, /reserves/<chantier>, /tableaux-de-bord). Les routes de fichiers (preuve, PDF de PV,
 * sélection de chantier) ne sont jamais poussées dans l'historique (liens <a href>, formulaire) et restent couvertes par la
 * règle NetworkOnly du SW et par la purge. Fonction pure, sans Prisma : utilisable dans le middleware (runtime Edge).
 */
const SCRIPT_SWE_WORKER = /^\/swe-worker-[A-Za-z0-9_-]+\.js$/

export function estPagePriveeLotD(pathname: string): boolean {
  if (pathname === "/reserves" || pathname === "/tableaux-de-bord") return true
  const m = /^\/reserves\/([^/]+)$/.exec(pathname)
  return !!m && m[1] !== "chantier"
}

function referentSweWorker(referent: string | null, origine: string): boolean {
  if (!referent) return false
  try {
    const u = new URL(referent)
    return u.origin === origine && SCRIPT_SWE_WORKER.test(u.pathname)
  } catch {
    return false
  }
}

export function refusLecturePageLotDParCacheDeNavigation(request: { nextUrl: URL; method?: string; headers?: Headers }): Response | null {
  const h = request.headers
  if (!h || (request.method ?? "GET").toUpperCase() !== "GET") return null
  if (!estPagePriveeLotD(request.nextUrl.pathname) || h.has("rsc")) return null
  const dest = h.get("sec-fetch-dest")
  if (dest !== null && dest !== "empty") return null
  if (!referentSweWorker(h.get("referer"), request.nextUrl.origin)) return null
  return new Response(null, { status: 403, headers: { "Cache-Control": "no-store" } })
}
