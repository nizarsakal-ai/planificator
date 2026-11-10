"use client"
import { useEffect, useRef, useState } from "react"

/**
 * Aperçu PDF privé rendu dans des <canvas>, sans lecteur PDF du navigateur, sans cadre, sans URL (même blob), sans
 * réseau : les octets déjà validés par fetchHrDocument (route, droits, MIME) sont passés tels quels au PDF.js local
 * fourni par la dépendance existante `unpdf` (sous-module `unpdf/pdfjs`, analyse inline sans worker séparé, chargé
 * seulement à l'ouverture d'un PDF). Aucun calque de texte, de liens ni de formulaires : rien de cliquable dans le
 * document, aucune navigation possible depuis l'aperçu. Rien n'est enregistré : « Télécharger » reste la seule sortie.
 *
 * Bornes : taille du fichier, nombre de pages, pixels par page et au total, délai de chargement. Au-delà, l'aperçu
 * s'arrête proprement (pages restantes signalées) ou affiche un message de repli ; il ne télécharge jamais.
 */
export const PDF_PREVIEW_LIMITS = {
  maxBytes: 10 * 1024 * 1024, // = MAX_PDF_BYTES du domaine RH
  maxPages: 20,
  maxCssWidth: 960,
  maxOutputScale: 2,
  maxPagePixels: 4_000_000,
  maxTotalPixels: 32_000_000,
  timeoutMs: 20_000,
} as const
export type PdfPreviewLimits = { [K in keyof typeof PDF_PREVIEW_LIMITS]: number }

export const PDF_CANVAS_MESSAGES = {
  loading: "Préparation de l’aperçu…",
  failed: "Ce PDF ne peut pas être affiché dans la page. Rien n’a été téléchargé : utilisez « Télécharger » pour l’ouvrir sur votre appareil.",
  tooLarge: "Ce PDF est trop volumineux pour l’aperçu. Rien n’a été téléchargé : utilisez « Télécharger » pour l’ouvrir sur votre appareil.",
  truncated: (shown: number, total: number) => `Aperçu limité aux ${shown} premières pages sur ${total} : utilisez « Télécharger » pour consulter le document complet.`,
} as const

export type PdfViewport = { width: number; height: number }
export type PdfRenderTask = { promise: Promise<unknown>; cancel: () => void }
export type PdfPage = {
  getViewport: (options: { scale: number }) => PdfViewport
  render: (options: { canvas: HTMLCanvasElement; canvasContext: CanvasRenderingContext2D; viewport: PdfViewport; transform?: number[] }) => PdfRenderTask
  cleanup?: () => unknown
}
export type PdfDocument = { numPages: number; getPage: (pageNumber: number) => Promise<PdfPage>; destroy: () => unknown }
/** Chargement annulable (forme de PDFDocumentLoadingTask) : destroy() interrompt le chargement ou détruit le document. */
export type PdfLoadingTask = { promise: Promise<PdfDocument>; destroy: () => unknown }
export type PdfLoader = (data: Uint8Array) => PdfLoadingTask

/** Taille d'affichage et de rendu d'une page, dans les bornes de pixels par page. */
export function pageGeometry(base: PdfViewport, containerWidth: number, devicePixelRatio: number, limits: PdfPreviewLimits = PDF_PREVIEW_LIMITS) {
  if (!(base.width > 0 && base.height > 0)) return null
  const cssWidth = Math.max(1, Math.min(containerWidth > 0 ? containerWidth : limits.maxCssWidth, limits.maxCssWidth))
  const scale = cssWidth / base.width
  const cssHeight = base.height * scale
  let output = Math.max(1, Math.min(Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1, limits.maxOutputScale))
  const pixels = cssWidth * cssHeight * output * output
  if (pixels > limits.maxPagePixels) output = Math.sqrt(limits.maxPagePixels / (cssWidth * cssHeight))
  const pixelWidth = Math.max(1, Math.floor(cssWidth * output)), pixelHeight = Math.max(1, Math.floor(cssHeight * output))
  return { scale, output, cssWidth, cssHeight, pixelWidth, pixelHeight }
}

export type PdfRenderState =
  | { status: "loading" }
  | { status: "ready"; shown: number; total: number }
  | { status: "error"; message: string }

type CanvasFactory = () => HTMLCanvasElement

/**
 * Délai d'une étape asynchrone. LIMITE ASSUMÉE : PDF.js s'exécute ici sur le fil principal (worker intégré, pas de
 * thread séparé). Un minuteur ne peut PAS interrompre une analyse ou un dessin synchrone en cours : il ne se déclenche
 * qu'au retour de la boucle d'événements. Le délai borne donc les attentes, pas le temps de calcul ; ce dernier n'est
 * borné qu'indirectement (taille, pages, pixels) et doit être MESURÉ en navigateur réel avant tout GO.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => { try { onTimeout?.() } finally { reject(new Error("PDF_TIMEOUT")) } }, ms) }),
  ]).finally(() => { if (timer !== undefined) clearTimeout(timer) })
}
/** Rend la main au navigateur entre deux pages (clic « Fermer », défilement) : le rendu reste interruptible entre pages. */
const yieldToBrowser = () => new Promise<void>(resolve => setTimeout(resolve, 0))

/** Libère la mémoire d'un canvas (navigateurs mobiles : mémoire canvas limitée). */
export function releaseCanvas(canvas: HTMLCanvasElement) { canvas.width = 0; canvas.height = 0; canvas.remove() }

/**
 * Rendu séquentiel, annulable : une page à la fois. Chargement, pages et dessins bornés par délai ; à l'expiration, à
 * l'erreur, à la fermeture ou au démontage : tâche de chargement détruite, document détruit EXACTEMENT une fois, y
 * compris s'il arrive après coup (résolution tardive), canvas libérés. Testable sans navigateur.
 */
export function createPdfCanvasSession({ load, createCanvas, onState, onPage, limits = PDF_PREVIEW_LIMITS }: {
  load: PdfLoader; createCanvas: CanvasFactory; onState: (state: PdfRenderState) => void
  onPage: (canvas: HTMLCanvasElement, pageNumber: number, total: number) => void; limits?: PdfPreviewLimits
}) {
  let cancelled = false, doc: PdfDocument | null = null, task: PdfRenderTask | null = null, loading: PdfLoadingTask | null = null
  const canvases: HTMLCanvasElement[] = []
  const destroyed = new WeakSet<object>()
  const quietly = (fn: () => unknown) => { try { const r = fn(); if (r && typeof (r as Promise<unknown>).catch === "function") void (r as Promise<unknown>).catch(() => {}) } catch { /* déjà libéré */ } }
  const destroyOnce = (d: PdfDocument | null | undefined) => { if (!d || destroyed.has(d)) return; destroyed.add(d); quietly(() => d.destroy()) }
  /** Abandon d'un chargement : destruction de la tâche, puis de tout document qui arriverait malgré tout. */
  const abandonLoading = () => {
    const t = loading; loading = null
    if (!t || destroyed.has(t)) return
    destroyed.add(t); quietly(() => t.destroy())
    t.promise.then(late => { destroyOnce(late) }, () => { /* chargement interrompu */ })
  }
  const destroyDoc = () => { const d = doc; doc = null; destroyOnce(d) }
  const cancelTask = () => { const t = task; task = null; if (t) quietly(() => t.cancel()) }
  const releaseAll = () => { cancelTask(); for (const canvas of canvases.splice(0)) releaseCanvas(canvas); abandonLoading(); destroyDoc() }
  return {
    get canvases() { return canvases.slice() },
    async render(blob: Blob, containerWidth: number, devicePixelRatio: number) {
      onState({ status: "loading" })
      if (blob.size > limits.maxBytes) { onState({ status: "error", message: PDF_CANVAS_MESSAGES.tooLarge }); return }
      try {
        const data = new Uint8Array(await blob.arrayBuffer())
        if (cancelled) return
        const current = load(data)
        loading = current
        const loaded = await withTimeout(current.promise, limits.timeoutMs, abandonLoading)
        if (cancelled || loading !== current) { destroyOnce(loaded); return }
        loading = null; doc = loaded
        const total = loaded.numPages, last = Math.min(total, limits.maxPages)
        let used = 0, shown = 0
        for (let n = 1; n <= last; n++) {
          if (n > 1) await yieldToBrowser()
          if (cancelled) return
          const page = await withTimeout(loaded.getPage(n), limits.timeoutMs)
          if (cancelled) return
          const g = pageGeometry(page.getViewport({ scale: 1 }), containerWidth, devicePixelRatio, limits)
          if (!g) throw new Error("PDF_PAGE_INVALID")
          if (used + g.pixelWidth * g.pixelHeight > limits.maxTotalPixels) break
          const canvas = createCanvas()
          canvas.width = g.pixelWidth; canvas.height = g.pixelHeight
          canvas.style.width = `${Math.floor(g.cssWidth)}px`; canvas.style.height = `${Math.floor(g.cssHeight)}px`
          const context = canvas.getContext("2d")
          if (!context) { releaseCanvas(canvas); throw new Error("PDF_CANVAS_UNAVAILABLE") }
          canvases.push(canvas)
          const viewport = page.getViewport({ scale: g.scale })
          const rendering = page.render({ canvas, canvasContext: context, viewport, transform: g.output !== 1 ? [g.output, 0, 0, g.output, 0, 0] : undefined })
          task = rendering
          await withTimeout(rendering.promise, limits.timeoutMs, cancelTask)
          if (task === rendering) task = null
          page.cleanup?.()
          if (cancelled) return
          used += g.pixelWidth * g.pixelHeight; shown = n
          onPage(canvas, n, total)
        }
        if (cancelled) return
        if (!shown) throw new Error("PDF_EMPTY")
        onState({ status: "ready", shown, total })
      } catch {
        // Tout échec (délai, PDF illisible, page invalide) : libération complète, document compris.
        releaseAll()
        if (cancelled) return
        onState({ status: "error", message: PDF_CANVAS_MESSAGES.failed })
      }
    },
    dispose() {
      cancelled = true
      releaseAll()
    },
  }
}

/**
 * Chargeur réel : PDF.js local de `unpdf` (dépendance déjà présente, aucun ajout au lockfile). Données passées en mémoire,
 * aucune URL de polices, cartes de caractères ou WebAssembly : aucune requête réseau. XFA désactivé. La tâche de
 * chargement de PDF.js est exposée telle quelle (destroy() conservé) : elle reste annulable avant résolution.
 */
export const loadPdfDocument: PdfLoader = data => {
  let task: { promise: Promise<unknown>; destroy: () => Promise<void> } | null = null, abandoned = false
  const promise = import("unpdf/pdfjs").then(({ getDocument }) => {
    task = getDocument({ data, enableXfa: false, useSystemFonts: true, stopAtErrors: false }) as unknown as { promise: Promise<unknown>; destroy: () => Promise<void> }
    if (abandoned) { void task.destroy().catch(() => {}); throw new Error("PDF_ABANDONED") }
    return task.promise as Promise<PdfDocument>
  })
  return { promise, destroy: () => { abandoned = true; return task?.destroy() } }
}

/** Composant d'aperçu : zone défilable au clavier, pages annoncées, message de repli sans téléchargement. */
export function PdfCanvasPreview({ blob, title, load = loadPdfDocument }: { blob: Blob; title: string; load?: PdfLoader }) {
  const pagesRef = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<PdfRenderState>({ status: "loading" })
  useEffect(() => {
    const host = pagesRef.current
    if (!host) return
    const session = createPdfCanvasSession({
      load,
      createCanvas: () => document.createElement("canvas"),
      onState: setState,
      onPage: (canvas, n, total) => {
        canvas.setAttribute("role", "img")
        canvas.setAttribute("aria-label", `Page ${n} sur ${total} de ${title}`)
        canvas.className = "mx-auto block max-w-full rounded border border-slate-200 bg-white"
        host.appendChild(canvas)
      },
    })
    void session.render(blob, host.clientWidth, window.devicePixelRatio || 1)
    return () => session.dispose()
  }, [blob, title, load])
  return <div className="space-y-2">
    <div ref={pagesRef} tabIndex={0} role="region" aria-label={`Aperçu de ${title}`} aria-busy={state.status === "loading"}
      className="max-h-[70vh] space-y-3 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"/>
    {state.status === "loading" && <p role="status" className="text-sm text-slate-600">{PDF_CANVAS_MESSAGES.loading}</p>}
    {state.status === "ready" && state.shown < state.total && <p role="status" className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-950">{PDF_CANVAS_MESSAGES.truncated(state.shown, state.total)}</p>}
    {state.status === "error" && <p role="status" className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-950">{state.message}</p>}
  </div>
}
