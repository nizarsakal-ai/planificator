"use client"
/**
 * Document Studio — espace PDF (lots 1 et 2) : visionneuse et « Remplir et signer ».
 *
 * Lot 1 (consulter) : le PDF est lu UNE fois depuis la route protégée de sa révision, puis rendu en mémoire par le PDF.js
 * local de `unpdf` (aucun lecteur PDF du navigateur, aucun cadre, aucune requête tierce). Pages rendues à l'approche de
 * l'écran seulement (un long PDF reste fluide), re-rendues au zoom ; vignettes pour naviguer ; la taille de chaque page
 * est connue du serveur, si bien que la mise en page (et les ancres #page-N de la recherche) existe avant le rendu.
 *
 * Lot 2 (remplir et signer) : un calque par page reçoit textes, dates, coches et signature, déplaçables à la souris, au
 * doigt ou au clavier (flèches ; Suppr pour retirer). Rien n'est écrit dans le navigateur : la liste des éléments et le
 * tracé de la signature sont envoyés au serveur, qui revalide tout et écrit une NOUVELLE version ; l'original reste intact.
 *
 * Lot 3 (organiser les pages) : grille des pages ; déplacer (boutons, clavier, glisser-déposer), pivoter, retirer ;
 * « Enregistrer » envoie le plan (nouvelle version) ; « Extraire » envoie les pages sélectionnées (nouveau PDF).
 *
 * Lot 4 : annoter (surligner et encadrer se tracent en glissant, la note se pose d'un clic) dans « Remplir et signer » ;
 * « Biffer » : zones noires tracées sur les pages, puis « Préparer » dessine chaque page biffée en image dans le
 * navigateur (PDF.js, zones peintes en noir) et montre le résultat ; seul ce rendu remplace la page à l'enregistrement.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react"
import { ArrowLeft, ArrowRight, Calendar, Check, Download, Eye, EyeOff, Highlighter, LayoutGrid, Minus, Move, PenLine, Plus, RotateCcw, RotateCw, Scissors, Signature, Square, StickyNote, Trash2, Type, Undo2, ZoomIn, ZoomOut } from "lucide-react"
import { loadPdfDocument, type PdfDocument, type PdfLoadingTask, type PdfRenderTask } from "@/components/hr-documents/PdfCanvasPreview"
import { StudioSignatureField } from "@/components/document-studio/StudioSignatureField"
import { FormulaireRetour } from "@/components/crm/RetourFormulaire"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { extractPagesAction, fillSignPdfAction, organizePdfAction, redactPdfAction } from "@/lib/actions/document-studio.actions"
import { COORD_MAX, OPERATION_LABEL, PDF_LIMITS, RECT_KINDS, addRotation, dayText, isIdentityPlan, pageRanges, unsupportedChars, type OperationKind, type PlannedPage, type Rotation } from "@/lib/document-studio/pdf-workspace.core"
import { moveItem, newItem, parisToday, rectFromCorners, resizeItem, toPayload, type EditorItem } from "@/lib/document-studio/pdf-workspace.editor"

export interface WorkspacePage { width: number; height: number }
export interface StudioPdfWorkspaceProps {
  pdfId: string
  title: string
  revisionId: string
  revisionNumber: number
  fileUrl: string
  downloadUrl: string
  pages: WorkspacePage[]
  /** Remplir et signer possible (dernière version, PDF non chiffré) ; sinon motif affiché. */
  editable: boolean
  editBlockedReason: string | null
  /** Lot 3 : extraire possible (PDF non chiffré, toute version). Organiser suit `editable`. */
  extractable: boolean
}

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const
const MAX_PAGE_PIXELS = 8_000_000
const LOAD_TIMEOUT_MS = 30_000
const INK = "#0f2154"
const TOOL_ICON: Record<OperationKind, typeof Type> = { text: Type, date: Calendar, check: Check, signature: Signature, highlight: Highlighter, box: Square, note: StickyNote }
const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f3460] focus-visible:ring-offset-1"

type LoadState = { status: "loading" } | { status: "ready"; doc: PdfDocument } | { status: "error"; message: string }

/** Lecture unique des octets de la révision, puis chargement PDF.js annulable. */
function usePdfDocument(url: string): LoadState {
  const [state, setState] = useState<LoadState>({ status: "loading" })
  useEffect(() => {
    let cancelled = false
    let task: PdfLoadingTask | null = null
    let doc: PdfDocument | null = null
    const timer = setTimeout(() => { if (!doc && !cancelled) { cancelled = true; void task?.destroy(); setState({ status: "error", message: "Le PDF met trop de temps à s'ouvrir. Utilisez « Télécharger »." }) } }, LOAD_TIMEOUT_MS)
    setState({ status: "loading" })
    void (async () => {
      try {
        const res = await fetch(url, { credentials: "same-origin", cache: "no-store" })
        if (!res.ok) throw new Error(`HTTP_${res.status}`)
        const data = new Uint8Array(await res.arrayBuffer())
        if (cancelled) return
        task = loadPdfDocument(data)
        const loaded = await task.promise
        if (cancelled) { void Promise.resolve(loaded.destroy()).catch(() => {}); return }
        doc = loaded
        clearTimeout(timer)
        setState({ status: "ready", doc: loaded })
      } catch {
        if (!cancelled) setState({ status: "error", message: "Ce PDF ne peut pas être affiché dans la page. Utilisez « Télécharger » pour l'ouvrir sur votre appareil." })
      }
    })()
    return () => {
      cancelled = true
      clearTimeout(timer)
      if (doc) void Promise.resolve(doc.destroy()).catch(() => {})
      else void Promise.resolve(task?.destroy()).catch(() => {})
    }
  }, [url])
  return state
}

/** État de rendu d'UN canvas : tâche en cours et génération (seul le dernier rendu demandé dessine). */
interface DrawState { task: PdfRenderTask | null; gen: number }

/**
 * Rendu d'une page dans un canvas à la largeur CSS donnée. Rendus SÉRIALISÉS par canvas : le rendu précédent est annulé
 * et attendu avant de redimensionner le canvas (PDF.js refuse deux rendus simultanés sur un même canvas et un rendu
 * interrompu laisserait un dessin partiel) ; une demande dépassée par une plus récente s'arrête sans dessiner.
 */
async function drawPage(doc: PdfDocument, n: number, canvas: HTMLCanvasElement, cssWidth: number, st: DrawState) {
  const my = ++st.gen
  const previous = st.task
  previous?.cancel()
  const page = await doc.getPage(n)
  if (previous) { try { await previous.promise } catch { /* annulé */ } }
  if (my !== st.gen) return
  const base = page.getViewport({ scale: 1 })
  if (!(base.width > 0 && cssWidth > 0)) return
  const scale = cssWidth / base.width
  const cssHeight = base.height * scale
  let out = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2)
  if (cssWidth * cssHeight * out * out > MAX_PAGE_PIXELS) out = Math.sqrt(MAX_PAGE_PIXELS / (cssWidth * cssHeight))
  const viewport = page.getViewport({ scale: scale * out })
  const ctx = canvas.getContext("2d")
  if (!ctx) return
  canvas.width = Math.max(1, Math.floor(viewport.width))
  canvas.height = Math.max(1, Math.floor(viewport.height))
  const task = page.render({ canvas, canvasContext: ctx, viewport })
  st.task = task
  try { await task.promise } catch { /* rendu annulé (zoom, démontage) */ } finally { if (st.task === task) st.task = null }
}

/** Canvas rendu quand son conteneur approche de l'écran, re-rendu quand sa largeur change (zoom, fenêtre). */
function LazyCanvas({ doc, n, label, eager = false }: { doc: PdfDocument | null; n: number; label: string; eager?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const draw = useRef<DrawState>({ task: null, gen: 0 })
  const [visible, setVisible] = useState(eager)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current?.parentElement
    if (!el) return
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) setVisible(true) }, { rootMargin: "800px 0px" })
    let frame = 0
    const ro = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => setWidth(Math.round(el.clientWidth))) })
    io.observe(el); ro.observe(el)
    return () => { io.disconnect(); ro.disconnect(); cancelAnimationFrame(frame) }
  }, [])
  useEffect(() => {
    const canvas = ref.current
    if (!doc || !visible || !canvas || width < 2) return
    void drawPage(doc, n, canvas, width, draw.current)
  }, [doc, n, visible, width])
  useEffect(() => {
    const st = draw.current, c = ref.current
    return () => { st.gen++; st.task?.cancel(); if (c) { c.width = 0; c.height = 0 } }
  }, [])
  return <canvas ref={ref} role="img" aria-label={label} className="absolute inset-0 h-full w-full" />
}

/** Signature tracée : recadrée sur le trait (marge de 6 px) pour que la boîte posée corresponde à l'encre. */
async function trimSignature(dataUrl: string): Promise<{ dataUrl: string; ratio: number } | null> {
  if (!dataUrl) return null
  const img = new Image()
  img.src = dataUrl
  await img.decode().catch(() => undefined)
  const w = img.naturalWidth, h = img.naturalHeight
  if (!w || !h) return null
  const c = document.createElement("canvas")
  c.width = w; c.height = h
  const ctx = c.getContext("2d")
  if (!ctx) return null
  ctx.drawImage(img, 0, 0)
  const px = ctx.getImageData(0, 0, w, h).data
  let minX = w, minY = h, maxX = -1, maxY = -1
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (px[(y * w + x) * 4 + 3] > 16) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
  }
  if (maxX < 0) return null
  const m = 6
  minX = Math.max(0, minX - m); minY = Math.max(0, minY - m); maxX = Math.min(w - 1, maxX + m); maxY = Math.min(h - 1, maxY + m)
  const out = document.createElement("canvas")
  out.width = maxX - minX + 1; out.height = maxY - minY + 1
  out.getContext("2d")?.drawImage(c, minX, minY, out.width, out.height, 0, 0, out.width, out.height)
  return { dataUrl: out.toDataURL("image/png"), ratio: out.height / out.width }
}

// ── Lot 4 : biffer ──────────────────────────────────────────────────────────────────────────────────────────────────

interface RedRect { id: string; page: number; x: number; y: number; w: number; h: number }
interface Prepared { images: Record<number, string>; key: string }

/** Zones regroupées par page (ordre des pages), forme attendue par le serveur. */
function groupRedactions(rects: readonly RedRect[]): { page: number; rects: { x: number; y: number; w: number; h: number }[] }[] {
  const by = new Map<number, { x: number; y: number; w: number; h: number }[]>()
  for (const r of rects) by.set(r.page, [...(by.get(r.page) ?? []), { x: r.x, y: r.y, w: r.w, h: r.h }])
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([page, rs]) => ({ page, rects: rs }))
}

const REDACT_TARGET_WIDTH = 1700
const REDACT_MAX_PIXELS = 5_000_000
/** Poids estimé (octets) d'une URL de données base64. */
const dataUrlBytes = (u: string) => Math.floor((u.length - u.indexOf(",") - 1) * 0.75)

/**
 * Rendu des pages biffées : chaque page est dessinée par PDF.js (rotation comprise), les zones sont peintes en noir
 * opaque (débord d'un pixel), puis l'image est encodée en JPEG ; la qualité baisse si le poids dépasse les bornes du
 * serveur. Aucune donnée ne quitte le navigateur avant l'enregistrement.
 */
async function rasterizeRedactions(doc: PdfDocument, redactions: ReturnType<typeof groupRedactions>): Promise<{ images: Record<number, string> }> {
  const images: Record<number, string> = {}
  let total = 0
  for (const r of redactions) {
    const page = await doc.getPage(r.page)
    const base = page.getViewport({ scale: 1 })
    const scale = Math.min(REDACT_TARGET_WIDTH / base.width, Math.sqrt(REDACT_MAX_PIXELS / (base.width * base.height)))
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.floor(viewport.width)); canvas.height = Math.max(1, Math.floor(viewport.height))
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("CANVAS")
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvas, canvasContext: ctx, viewport }).promise
    ctx.fillStyle = "#000000"
    for (const z of r.rects) {
      const x = Math.floor((z.x / COORD_MAX) * canvas.width) - 1, y = Math.floor((z.y / COORD_MAX) * canvas.height) - 1
      ctx.fillRect(x, y, Math.ceil((z.w / COORD_MAX) * canvas.width) + 2, Math.ceil((z.h / COORD_MAX) * canvas.height) + 2)
    }
    let url = ""
    for (const q of [0.85, 0.75, 0.62, 0.5]) {
      url = canvas.toDataURL("image/jpeg", q)
      if (dataUrlBytes(url) <= PDF_LIMITS.maxRedactImageBytes * 0.95) break
    }
    canvas.width = 0; canvas.height = 0
    const bytes = dataUrlBytes(url)
    if (bytes > PDF_LIMITS.maxRedactImageBytes * 0.95) throw new Error("TOO_LARGE")
    total += bytes
    if (total > PDF_LIMITS.maxRedactImagesBytes * 0.95) throw new Error("TOO_LARGE")
    images[r.page] = url
  }
  return { images }
}

let seq = 0
const nextId = () => `el${Date.now().toString(36)}${(seq++).toString(36)}`

export function StudioPdfWorkspace(p: StudioPdfWorkspaceProps) {
  const uid = useId()
  const load = usePdfDocument(p.fileUrl)
  const doc = load.status === "ready" ? load.doc : null
  const [zoom, setZoom] = useState<number>(1)
  const [mode, setMode] = useState<"view" | "edit" | "organize" | "redact">("view")
  // Lot 4 : zones à biffer, rectangle en cours de tracé, rendu préparé des pages biffées.
  const [redRects, setRedRects] = useState<RedRect[]>([])
  const [selRed, setSelRed] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ page: number; x: number; y: number; w: number; h: number } | null>(null)
  const [prepared, setPrepared] = useState<Prepared | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [prepError, setPrepError] = useState<string | null>(null)
  const creating = useRef<{ page: number; x0: number; y0: number; left: number; top: number; w: number; h: number; target: "item" | "redact"; kind: OperationKind | null } | null>(null)
  const [tool, setTool] = useState<OperationKind | null>(null)
  const [items, setItems] = useState<EditorItem[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [signature, setSignature] = useState<{ dataUrl: string; ratio: number } | null>(null)
  const [signerName, setSignerName] = useState("")
  const [currentPage, setCurrentPage] = useState(1)
  const scroller = useRef<HTMLDivElement>(null)
  const today = useMemo(() => parisToday(), [])
  const maxWidth = useMemo(() => Math.max(...p.pages.map((pg) => pg.width)), [p.pages])
  const sel = items.find((i) => i.id === selected) ?? null
  const payload = useMemo(() => toPayload(items), [items])
  const usesSignature = payload.some((o) => o.kind === "signature")
  const badChars = useMemo(() => [...new Set(items.filter((i) => i.kind === "text" || i.kind === "note").flatMap((i) => unsupportedChars(i.text)))], [items])
  const redactions = useMemo(() => groupRedactions(redRects), [redRects])
  const redKey = JSON.stringify(redactions)
  const preparedOk = prepared !== null && prepared.key === redKey

  // Page courante : celle dont le haut est le plus proche du haut de la zone de lecture.
  useEffect(() => {
    const root = scroller.current
    if (!root) return
    const els = [...root.querySelectorAll<HTMLElement>("[data-page]")]
    const io = new IntersectionObserver((entries) => {
      const best = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
      if (best) setCurrentPage(Number((best.target as HTMLElement).dataset.page))
    }, { root, threshold: [0, 0.25, 0.5] })
    els.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [p.pages.length, mode])

  const goTo = (n: number) => {
    const el = scroller.current?.querySelector<HTMLElement>(`#page-${n}`)
    el?.scrollIntoView({ block: "start", behavior: "auto" })
    el?.focus({ preventScroll: true })
  }
  const zoomBy = (d: 1 | -1) => setZoom((z) => { const i = ZOOMS.findIndex((v) => v >= z); return ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, i + d))] })
  const update = useCallback((id: string, f: (it: EditorItem) => EditorItem) => setItems((xs) => xs.map((x) => (x.id === id ? f(x) : x))), [])
  const remove = useCallback((id: string) => { setItems((xs) => xs.filter((x) => x.id !== id)); setSelected(null) }, [])

  /** Début d'un rectangle tracé (surligner, encadrer, zone à biffer) : le calque capte le pointeur jusqu'au relâchement. */
  const startCreate = (e: ReactPointerEvent<HTMLDivElement>, page: number, target: "item" | "redact", kind: OperationKind | null) => {
    const r = e.currentTarget.getBoundingClientRect()
    const x0 = ((e.clientX - r.left) / r.width) * COORD_MAX, y0 = ((e.clientY - r.top) / r.height) * COORD_MAX
    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
    creating.current = { page, x0, y0, left: r.left, top: r.top, w: r.width, h: r.height, target, kind }
    setDraft({ page, x: x0, y: y0, w: 0, h: 0 })
  }
  const moveCreate = (e: ReactPointerEvent<HTMLDivElement>) => {
    const c = creating.current
    if (!c) return
    const x = ((e.clientX - c.left) / c.w) * COORD_MAX, y = ((e.clientY - c.top) / c.h) * COORD_MAX
    setDraft({ page: c.page, x: Math.min(x, c.x0), y: Math.min(y, c.y0), w: Math.abs(x - c.x0), h: Math.abs(y - c.y0) })
  }
  const endCreate = (e: ReactPointerEvent<HTMLDivElement>) => {
    const c = creating.current
    creating.current = null
    setDraft(null)
    if (!c) return
    const rect = rectFromCorners(c.x0, c.y0, ((e.clientX - c.left) / c.w) * COORD_MAX, ((e.clientY - c.top) / c.h) * COORD_MAX)
    if (!rect) return
    if (c.target === "redact") {
      if (redRects.filter((r) => r.page === c.page).length >= PDF_LIMITS.maxRedactRectsPerPage) return
      const id = nextId()
      setRedRects((xs) => [...xs, { id, page: c.page, ...rect }])
      setSelRed(id)
    } else if (c.kind) {
      if (items.length >= PDF_LIMITS.maxOperations) return
      const it = { ...newItem(c.kind, c.page, rect.x, rect.y, nextId(), today), w: rect.w, h: rect.h }
      setItems((xs) => [...xs, it])
      setSelected(it.id)
      setTool(null)
    }
  }

  const placeAt = (e: ReactPointerEvent<HTMLDivElement>, page: number) => {
    if (mode === "redact") { if (e.target === e.currentTarget) { setSelRed(null); startCreate(e, page, "redact", null) } return }
    if (mode !== "edit" || !tool || e.target !== e.currentTarget) { if (e.target === e.currentTarget) setSelected(null); return }
    if (RECT_KINDS.includes(tool)) { startCreate(e, page, "item", tool); return }
    const r = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * COORD_MAX
    const y = ((e.clientY - r.top) / r.height) * COORD_MAX
    // Pas de déplacement du focus par le clic : le champ de texte créé le reçoit juste après le rendu.
    e.preventDefault()
    if (items.length >= PDF_LIMITS.maxOperations) return
    const it = newItem(tool, page, x, y, nextId(), today)
    setItems((xs) => [...xs, it])
    setSelected(it.id)
    setTool(null)
    pendingFocus.current = it.id
  }
  const pendingFocus = useRef<string | null>(null)
  useEffect(() => {
    const id = pendingFocus.current
    if (!id) return
    pendingFocus.current = null
    const el = scroller.current?.querySelector<HTMLElement>(`[data-item="${id}"]`)
    const target = el?.querySelector<HTMLInputElement>("input") ?? el
    target?.focus({ preventScroll: true })
  }, [items])

  // Déplacement à la souris ou au doigt : écart converti en dix-millièmes de la page.
  const drag = useRef<{ id: string; sx: number; sy: number; x0: number; y0: number; w: number; h: number } | null>(null)
  const startDrag = (e: ReactPointerEvent<HTMLElement>, it: EditorItem) => {
    const overlay = e.currentTarget.closest<HTMLElement>("[data-overlay]")
    if (!overlay) return
    const r = overlay.getBoundingClientRect()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { id: it.id, sx: e.clientX, sy: e.clientY, x0: it.x, y0: it.y, w: r.width, h: r.height }
    setSelected(it.id)
    e.stopPropagation()
  }
  const onDrag = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d) return
    update(d.id, (it) => moveItem(it, d.x0 + ((e.clientX - d.sx) / d.w) * COORD_MAX, d.y0 + ((e.clientY - d.sy) / d.h) * COORD_MAX))
  }
  const endDrag = () => { drag.current = null }
  const onItemKey = (e: ReactKeyboardEvent<HTMLElement>, it: EditorItem) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return
    const step = e.shiftKey ? 100 : 20
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    if (moves[e.key]) { e.preventDefault(); update(it.id, (x) => moveItem(x, x.x + moves[e.key][0], x.y + moves[e.key][1])) }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); remove(it.id) }
  }

  const renderItem = (it: EditorItem, pg: WorkspacePage) => {
    const isSel = it.id === selected
    const ring = isSel ? "ring-2 ring-[#0f3460]" : "ring-1 ring-[#0f3460]/40 hover:ring-[#0f3460]"
    const pos = { left: `${(it.x / COORD_MAX) * 100}%`, top: `${(it.y / COORD_MAX) * 100}%` }
    // Taille de police en unités de conteneur : identique à l'échelle du rendu (1 pt PDF = 100/largeur % de la page).
    const fontSize = `calc(${it.size} * 100cqw / ${pg.width})`
    const common = {
      "data-item": it.id, tabIndex: 0, "aria-label": `${OPERATION_LABEL[it.kind]} page ${it.page}`, onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => onItemKey(e, it),
      onFocus: () => setSelected(it.id),
    }
    if (it.kind === "highlight" || it.kind === "box") {
      const size = { width: `${(it.w / COORD_MAX) * 100}%`, height: `${(it.h / COORD_MAX) * 100}%` }
      return (
        <div key={it.id} {...common} onPointerDown={(e) => startDrag(e, it)} onPointerMove={onDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
          className={`absolute cursor-move touch-none ${it.kind === "highlight" ? "bg-yellow-300/40" : "border-2 border-[#c71a2b]"} ${isSel ? "ring-2 ring-[#0f3460] ring-offset-1" : ""} ${FOCUS}`} style={{ ...pos, ...size }} />
      )
    }
    if (it.kind === "text" || it.kind === "note") {
      const note = it.kind === "note"
      return (
        <div key={it.id} {...common} className={`absolute rounded-sm ${note ? "border border-yellow-600 bg-yellow-100 px-[0.35em] py-[0.17em]" : "bg-sky-100/40"} ${ring} ${FOCUS}`} style={{ ...pos, fontSize, lineHeight: 1 }}>
          <button type="button" aria-label="Déplacer" title="Déplacer" onPointerDown={(e) => startDrag(e, it)} onPointerMove={onDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
            className="absolute -left-5 top-0 flex h-4 w-4 cursor-move touch-none items-center justify-center rounded bg-[#0f3460] text-white"><Move aria-hidden="true" className="h-3 w-3" /></button>
          <input value={it.text} maxLength={PDF_LIMITS.maxTextLength} aria-label={`${note ? "Note" : "Texte"} page ${it.page}`} placeholder={note ? "Note…" : "Saisir…"}
            onChange={(e) => update(it.id, (x) => ({ ...x, text: e.target.value }))} onFocus={() => setSelected(it.id)}
            size={Math.max(6, it.text.length + 1)}
            className="block border-0 bg-transparent p-0 outline-none placeholder:text-slate-400"
            style={{ fontFamily: "Helvetica, Arial, sans-serif", fontSize: "1em", lineHeight: 1, height: "1em", color: INK}} />
        </div>
      )
    }
    const dragProps = { onPointerDown: (e: ReactPointerEvent<HTMLElement>) => startDrag(e, it), onPointerMove: onDrag, onPointerUp: endDrag, onPointerCancel: endDrag }
    if (it.kind === "date") {
      return <div key={it.id} {...common} {...dragProps} className={`absolute cursor-move touch-none whitespace-nowrap rounded-sm bg-sky-100/40 ${ring} ${FOCUS}`} style={{ ...pos, fontSize, lineHeight: 1, fontFamily: "Helvetica, Arial, sans-serif", color: INK }}>{dayText(it.date)}</div>
    }
    if (it.kind === "check") {
      const side = `${(it.size / COORD_MAX) * 100}cqw`
      return (
        <div key={it.id} {...common} {...dragProps} className={`absolute cursor-move touch-none rounded-sm bg-sky-100/40 ${ring} ${FOCUS}`} style={{ ...pos, width: side, height: side }}>
          <svg viewBox="0 0 100 100" className="h-full w-full" aria-hidden="true"><polyline points="10,55 40,85 90,15" fill="none" stroke={INK} strokeWidth="12" strokeLinecap="butt" /></svg>
        </div>
      )
    }
    const w = `${(it.width / COORD_MAX) * 100}cqw`
    return (
      <div key={it.id} {...common} {...dragProps} className={`absolute cursor-move touch-none rounded-sm bg-sky-100/30 ${ring} ${FOCUS}`} style={{ ...pos, width: w, aspectRatio: signature ? `1 / ${signature.ratio}` : "3 / 1" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {signature ? <img src={signature.dataUrl} alt="" className="h-full w-full select-none" draggable={false} /> : <span className="flex h-full items-center justify-center text-[10px] text-[#0f3460]">Signature à tracer</span>}
      </div>
    )
  }

  const editing = mode === "edit"
  const redacting = mode === "redact"
  const prepare = async () => {
    if (!doc || redactions.length === 0) return
    setPreparing(true); setPrepError(null)
    try {
      const r = await rasterizeRedactions(doc, redactions)
      setPrepared({ ...r, key: redKey })
    } catch (e) {
      setPrepared(null)
      setPrepError(e instanceof Error && e.message === "TOO_LARGE" ? "Rendu trop lourd : biffez moins de pages à la fois." : "Le rendu des pages biffées a échoué : réessayez.")
    } finally {
      setPreparing(false)
    }
  }
  const removeRed = (id: string) => { setRedRects((xs) => xs.filter((x) => x.id !== id)); setSelRed(null) }
  const organizing = mode === "organize"
  return (
    <div className="space-y-3">
      {/* Barre d'outils */}
      <div role="toolbar" aria-label="Outils de la visionneuse" className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-2 shadow-sm">
        <div className="flex min-w-0 flex-wrap items-center gap-1" role="group" aria-label="Mode">
          <Button type="button" size="sm" variant={mode === "view" ? "default" : "outline"} aria-pressed={mode === "view"} onClick={() => { setMode("view"); setTool(null) }}><Eye aria-hidden="true" className="mr-1 h-4 w-4" />Consulter</Button>
          <Button type="button" size="sm" variant={editing ? "default" : "outline"} aria-pressed={editing} disabled={!p.editable} onClick={() => setMode("edit")} title={p.editBlockedReason ?? undefined}><PenLine aria-hidden="true" className="mr-1 h-4 w-4" />Remplir et signer</Button>
          <Button type="button" size="sm" variant={organizing ? "default" : "outline"} aria-pressed={organizing} disabled={!p.extractable} onClick={() => { setMode("organize"); setTool(null) }}><LayoutGrid aria-hidden="true" className="mr-1 h-4 w-4" />Organiser les pages</Button>
          <Button type="button" size="sm" variant={redacting ? "default" : "outline"} aria-pressed={redacting} disabled={!p.editable} onClick={() => { setMode("redact"); setTool(null) }} title={p.editBlockedReason ?? undefined}><EyeOff aria-hidden="true" className="mr-1 h-4 w-4" />Biffer</Button>
        </div>
        <span className="mx-1 hidden h-6 w-px bg-slate-200 sm:block" aria-hidden="true" />
        <div className="flex items-center gap-1" role="group" aria-label="Zoom">
          <Button type="button" size="sm" variant="outline" onClick={() => zoomBy(-1)} disabled={zoom <= ZOOMS[0]} aria-label="Zoom arrière"><ZoomOut aria-hidden="true" className="h-4 w-4" /></Button>
          <button type="button" onClick={() => setZoom(1)} className={`min-w-14 rounded-md px-2 py-1 text-sm tabular-nums text-slate-700 hover:bg-slate-100 ${FOCUS}`} aria-label={`Zoom ${Math.round(zoom * 100)} %, revenir à 100 %`}>{Math.round(zoom * 100)} %</button>
          <Button type="button" size="sm" variant="outline" onClick={() => zoomBy(1)} disabled={zoom >= ZOOMS[ZOOMS.length - 1]} aria-label="Zoom avant"><ZoomIn aria-hidden="true" className="h-4 w-4" /></Button>
        </div>
        <label className="flex items-center gap-1 text-sm text-slate-700">
          <span className="sr-only">Aller à la page</span>
          <span aria-hidden="true">Page</span>
          <select value={currentPage} onChange={(e) => goTo(Number(e.target.value))} className="h-8 rounded-md border border-slate-300 bg-white px-1 text-sm">
            {p.pages.map((_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
          </select>
          <span aria-hidden="true">/ {p.pages.length}</span>
        </label>
        <a href={p.downloadUrl} className={`ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-[#0f3460] hover:bg-slate-100 ${FOCUS}`}><Download aria-hidden="true" className="h-4 w-4" />Télécharger</a>
      </div>
      {!p.editable && p.editBlockedReason && <p className="text-xs text-slate-600">{p.editBlockedReason}</p>}

      {organizing && (
        <OrganizePanel doc={doc} pages={p.pages} pdfId={p.pdfId} revisionId={p.revisionId} revisionNumber={p.revisionNumber}
          canSave={p.editable} saveBlockedReason={p.editBlockedReason} title={p.title} />
      )}
      <div className={`${organizing ? "hidden" : "grid"} gap-3 ${editing || redacting ? "lg:grid-cols-[8rem_minmax(0,1fr)_19rem]" : "lg:grid-cols-[8rem_minmax(0,1fr)]"}`}>
        {/* Vignettes */}
        <nav aria-label="Pages" className="hidden max-h-[78vh] overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-2 lg:block">
          <ol className="space-y-2">
            {p.pages.map((pg, i) => (
              <li key={i}>
                <button type="button" onClick={() => goTo(i + 1)} aria-current={currentPage === i + 1 ? "page" : undefined} aria-label={`Page ${i + 1}`}
                  className={`block w-full rounded-md p-1 text-center ${currentPage === i + 1 ? "bg-[#0f3460]/10 ring-2 ring-[#0f3460]" : "hover:bg-white"} ${FOCUS}`}>
                  <span className="relative mx-auto block w-full bg-white shadow-sm" style={{ aspectRatio: `${pg.width} / ${pg.height}` }}>
                    <LazyCanvas doc={doc} n={i + 1} label="" />
                  </span>
                  <span className="mt-1 block text-[11px] text-slate-600">{i + 1}</span>
                </button>
              </li>
            ))}
          </ol>
        </nav>

        {/* Pages */}
        <div ref={scroller} role="region" aria-label={`Document ${p.title}, version ${p.revisionNumber}`} aria-busy={load.status === "loading"}
          className="max-h-[78vh] min-w-0 overflow-auto rounded-xl border border-slate-200 bg-slate-100 p-3">
          {load.status === "loading" && <p role="status" className="mb-2 text-sm text-slate-600">Ouverture du PDF…</p>}
          {load.status === "error" && <p role="status" className="mb-2 rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-950">{load.message}</p>}
          <div className="mx-auto max-w-[900px] space-y-4" style={{ width: zoom > 1 ? `${zoom * 100}%` : undefined, maxWidth: zoom > 1 ? `${900 * zoom}px` : undefined }}>
            {p.pages.map((pg, i) => {
              const n = i + 1
              const widthPct = (zoom < 1 ? zoom : 1) * (pg.width / maxWidth) * 100
              return (
                <div key={n} id={`page-${n}`} data-page={n} tabIndex={-1} className="relative mx-auto scroll-mt-2 bg-white shadow-md outline-none"
                  style={{ width: `${widthPct}%`, aspectRatio: `${pg.width} / ${pg.height}`, containerType: "inline-size" }}>
                  <LazyCanvas doc={doc} n={n} label={`Page ${n} sur ${p.pages.length}`} eager={n === 1} />
                  {(editing || redacting) && (
                    <div data-overlay="" onPointerDown={(e) => placeAt(e, n)} onPointerMove={moveCreate} onPointerUp={endCreate} onPointerCancel={endCreate}
                      className={`absolute inset-0 touch-none ${tool || redacting ? "cursor-crosshair" : ""}`} style={{ containerType: "inline-size" }}>
                      {editing && items.filter((it) => it.page === n).map((it) => renderItem(it, pg))}
                      {redacting && redRects.filter((r) => r.page === n).map((r) => (
                        <div key={r.id} tabIndex={0} role="img" aria-label={`Zone à biffer, page ${n}`}
                          onPointerDown={(e) => { e.stopPropagation(); setSelRed(r.id) }} onFocus={() => setSelRed(r.id)}
                          onKeyDown={(e) => { if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeRed(r.id) } }}
                          className={`absolute bg-black ${selRed === r.id ? "ring-2 ring-red-500 ring-offset-1" : ""} ${FOCUS}`}
                          style={{ left: `${(r.x / COORD_MAX) * 100}%`, top: `${(r.y / COORD_MAX) * 100}%`, width: `${(r.w / COORD_MAX) * 100}%`, height: `${(r.h / COORD_MAX) * 100}%` }}>
                          {selRed === r.id && (
                            <button type="button" aria-label="Retirer cette zone" onPointerDown={(e) => e.stopPropagation()} onClick={() => removeRed(r.id)}
                              className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-white text-red-700 shadow"><Trash2 aria-hidden="true" className="h-3 w-3" /></button>
                          )}
                        </div>
                      ))}
                      {draft && draft.page === n && (
                        <div aria-hidden="true" className={`pointer-events-none absolute border-2 border-dashed ${redacting ? "border-red-600 bg-black/60" : "border-[#0f3460] bg-[#0f3460]/10"}`}
                          style={{ left: `${(draft.x / COORD_MAX) * 100}%`, top: `${(draft.y / COORD_MAX) * 100}%`, width: `${(draft.w / COORD_MAX) * 100}%`, height: `${(draft.h / COORD_MAX) * 100}%` }} />
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* Panneau « Biffer » (lot 4) */}
        {redacting && (
          <aside aria-labelledby={`${uid}-bf`} className="order-first space-y-3 lg:order-none rounded-xl border border-slate-200 bg-white p-3 shadow-sm lg:max-h-[78vh] lg:overflow-y-auto">
            <h2 id={`${uid}-bf`} className="text-sm font-semibold text-slate-900">Biffer</h2>
            <p className="text-xs text-slate-600">Glissez sur la page pour tracer une zone noire. Cliquez une zone pour la sélectionner ; Suppr la retire.</p>
            <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
              Chaque page biffée est remplacée par son image : le texte caché est réellement supprimé de la nouvelle version, mais le texte de ces pages n&apos;y est plus sélectionnable. Les versions précédentes restent dans l&apos;historique du document.
            </p>
            <p className="text-xs text-slate-700" aria-live="polite">
              {redRects.length === 0 ? "Aucune zone tracée." : `${redRects.length} zone${redRects.length > 1 ? "s" : ""} sur ${redactions.length} page${redactions.length > 1 ? "s" : ""}${redactions.length > PDF_LIMITS.maxRedactPages ? ` : ${PDF_LIMITS.maxRedactPages} pages au plus par enregistrement` : ""}.`}
            </p>
            <Button type="button" variant="outline" className="w-full" onClick={() => void prepare()} disabled={!doc || preparing || redactions.length === 0 || redactions.length > PDF_LIMITS.maxRedactPages}>
              {preparing ? "Préparation…" : preparedOk ? "Préparer à nouveau" : "Préparer le biffage"}
            </Button>
            {prepError && <p className="text-xs text-red-700">{prepError}</p>}
            {prepared && !preparedOk && <p className="text-xs text-amber-800">Les zones ont changé depuis la préparation : préparez à nouveau.</p>}
            {preparedOk && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-slate-700">Aperçu des pages biffées : seul ce rendu sera conservé.</p>
                <ul className="grid grid-cols-2 gap-2">
                  {redactions.map((r) => (
                    <li key={r.page} className="text-center">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={prepared.images[r.page]} alt={`Page ${r.page} biffée`} className="w-full rounded border border-slate-200" />
                      <span className="text-[11px] text-slate-600">Page {r.page}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <FormulaireRetour action={redactPdfAction} className="space-y-2 border-t border-slate-200 pt-3">
              <input type="hidden" name="pdfId" value={p.pdfId} />
              <input type="hidden" name="baseRevisionId" value={p.revisionId} />
              <input type="hidden" name="redactions" value={preparedOk ? redKey : ""} />
              {preparedOk && redactions.map((r) => <input key={r.page} type="hidden" name={`img_${r.page}`} value={prepared.images[r.page]} />)}
              <Button type="submit" className="w-full" disabled={!preparedOk}>Enregistrer la version {p.revisionNumber + 1} biffée</Button>
            </FormulaireRetour>
          </aside>
        )}

        {/* Panneau « Remplir et signer » */}
        {editing && (
          <aside aria-labelledby={`${uid}-fs`} className="order-first space-y-4 lg:order-none rounded-xl border border-slate-200 bg-white p-3 shadow-sm lg:max-h-[78vh] lg:overflow-y-auto">
            <h2 id={`${uid}-fs`} className="text-sm font-semibold text-slate-900">Remplir, signer, annoter</h2>
            <div>
              <p className="mb-1.5 text-xs text-slate-600">Choisissez un outil puis cliquez sur la page à l&apos;endroit voulu ; pour surligner ou encadrer, glissez sur la zone.</p>
              <div className="grid grid-cols-2 gap-1.5" role="group" aria-label="Éléments à poser">
                {(Object.keys(OPERATION_LABEL) as OperationKind[]).map((k) => {
                  const Icon = TOOL_ICON[k]
                  return (
                    <button key={k} type="button" aria-pressed={tool === k} onClick={() => setTool(tool === k ? null : k)}
                      className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-sm ${tool === k ? "border-[#0f3460] bg-[#0f3460] text-white" : "border-slate-200 text-slate-800 hover:border-slate-300"} ${FOCUS}`}>
                      <Icon aria-hidden="true" className="h-4 w-4" />{OPERATION_LABEL[k]}
                    </button>
                  )
                })}
              </div>
            </div>

            {sel && (
              <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
                <p className="text-xs font-medium text-slate-700">{OPERATION_LABEL[sel.kind]} sélectionné · page {sel.page}</p>
                {sel.kind === "date" && (
                  <label className="grid gap-1 text-xs text-slate-600">Date
                    <Input type="date" value={sel.date} onChange={(e) => update(sel.id, (x) => ({ ...x, date: e.target.value || today }))} />
                  </label>
                )}
                <div className="flex items-center gap-1">
                  <span className="text-xs text-slate-600">Taille</span>
                  <Button type="button" size="sm" variant="outline" onClick={() => update(sel.id, (x) => resizeItem(x, -1))} aria-label="Réduire"><Minus aria-hidden="true" className="h-3.5 w-3.5" /></Button>
                  <span className="min-w-10 text-center text-xs tabular-nums text-slate-700">{sel.kind === "signature" ? `${Math.round(sel.width / 100)} %` : sel.kind === "check" ? `${Math.round(sel.size / 10) / 10} %` : sel.kind === "highlight" || sel.kind === "box" ? `${Math.round(sel.w / 100)} %` : `${sel.size} pt`}</span>
                  <Button type="button" size="sm" variant="outline" onClick={() => update(sel.id, (x) => resizeItem(x, 1))} aria-label="Agrandir"><Plus aria-hidden="true" className="h-3.5 w-3.5" /></Button>
                  <Button type="button" size="sm" variant="outline" className="ml-auto text-red-700" onClick={() => remove(sel.id)}><Trash2 aria-hidden="true" className="mr-1 h-3.5 w-3.5" />Retirer</Button>
                </div>
                <p className="text-[11px] text-slate-500">Déplacement : glisser, ou flèches du clavier (Maj : plus vite). Suppr retire l&apos;élément.</p>
              </div>
            )}

            <div className="space-y-2">
              <label className="grid gap-1 text-xs uppercase text-slate-500">Nom du signataire
                <Input value={signerName} onChange={(e) => setSignerName(e.target.value)} maxLength={120} autoComplete="name" />
              </label>
              <StudioSignatureField name="signatureTrace" label="Signature" onChange={(v) => { void trimSignature(v).then(setSignature) }} />
              {signature && !usesSignature && <p className="text-xs text-amber-800">Signature tracée : choisissez l&apos;outil « Signature » puis cliquez sur la page pour la poser.</p>}
            </div>

            <FormulaireRetour action={fillSignPdfAction} className="space-y-2 border-t border-slate-200 pt-3">
              <input type="hidden" name="pdfId" value={p.pdfId} />
              <input type="hidden" name="baseRevisionId" value={p.revisionId} />
              <input type="hidden" name="operations" value={JSON.stringify(payload)} />
              <input type="hidden" name="signerName" value={signerName} />
              <input type="hidden" name="signature" value={usesSignature && signature ? signature.dataUrl : ""} />
              <p className="text-xs text-slate-600" aria-live="polite">{payload.length === 0 ? "Aucun élément posé." : `${payload.length} élément${payload.length > 1 ? "s" : ""} prêt${payload.length > 1 ? "s" : ""} à enregistrer.`}</p>
              {badChars.length > 0 && <p className="text-xs text-red-700">Caractères non pris en charge : {badChars.slice(0, 5).join(" ")}</p>}
              {usesSignature && !signature && <p className="text-xs text-red-700">Tracez la signature avant d&apos;enregistrer.</p>}
              <Button type="submit" className="w-full" disabled={payload.length === 0 || badChars.length > 0 || (usesSignature && (!signature || signerName.trim().length < 2))}>
                Enregistrer la version {p.revisionNumber + 1}
              </Button>
              <p className="text-[11px] text-slate-500">L&apos;original et les versions précédentes restent intacts et téléchargeables.</p>
            </FormulaireRetour>
          </aside>
        )}
      </div>
    </div>
  )
}

// ── Lot 3 : organiser les pages ─────────────────────────────────────────────────────────────────────────────────────

interface OrganizeItem { page: number; rotate: Rotation; removed: boolean; selected: boolean }

/** Vignette d'une page pivotée de `rotate` dans un carré : la page entière reste visible quelle que soit la rotation. */
function RotatedThumb({ doc, n, pg, rotate, label }: { doc: PdfDocument | null; n: number; pg: WorkspacePage; rotate: number; label: string }) {
  const max = Math.max(pg.width, pg.height)
  return (
    <span className="relative block aspect-square w-full overflow-hidden rounded bg-slate-100">
      <span className="absolute left-1/2 top-1/2 block bg-white shadow-sm transition-transform motion-reduce:transition-none"
        style={{ width: `${(pg.width / max) * 100}%`, aspectRatio: `${pg.width} / ${pg.height}`, transform: `translate(-50%, -50%) rotate(${rotate}deg)` }}>
        <LazyCanvas doc={doc} n={n} label={label} />
      </span>
    </span>
  )
}

function OrganizePanel({ doc, pages, pdfId, revisionId, revisionNumber, canSave, saveBlockedReason, title }: {
  doc: PdfDocument | null; pages: WorkspacePage[]; pdfId: string; revisionId: string; revisionNumber: number
  canSave: boolean; saveBlockedReason: string | null; title: string
}) {
  const uid = useId()
  const initial = useCallback((): OrganizeItem[] => pages.map((_, i) => ({ page: i + 1, rotate: 0, removed: false, selected: false })), [pages])
  const [items, setItems] = useState<OrganizeItem[]>(initial)
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [announce, setAnnounce] = useState("")
  const plan: PlannedPage[] = items.filter((it) => !it.removed).map(({ page, rotate }) => ({ page, rotate }))
  const extract: PlannedPage[] = items.filter((it) => it.selected).map(({ page, rotate }) => ({ page, rotate }))
  const unchanged = isIdentityPlan(plan, pages.length)
  const extractAll = isIdentityPlan(extract, pages.length)

  const set = (i: number, f: (it: OrganizeItem) => OrganizeItem) => setItems((xs) => xs.map((x, j) => (j === i ? f(x) : x)))
  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length || from === to) return
    setItems((xs) => { const c = [...xs]; const [it] = c.splice(from, 1); c.splice(to, 0, it); return c })
    setAnnounce(`Page ${items[from].page} déplacée en position ${to + 1}.`)
    requestAnimationFrame(() => document.getElementById(`${uid}-card-${to}`)?.focus())
  }
  const onKey = (e: ReactKeyboardEvent<HTMLElement>, i: number) => {
    if (e.target !== e.currentTarget) return
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); move(i, i - 1) }
    else if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); move(i, i + 1) }
    else if (e.key === "r" || e.key === "R") { e.preventDefault(); set(i, (x) => ({ ...x, rotate: addRotation(x.rotate, e.shiftKey ? -90 : 90) })) }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); set(i, (x) => ({ ...x, removed: !x.removed })) }
    else if (e.key === " ") { e.preventDefault(); set(i, (x) => ({ ...x, selected: !x.selected })) }
  }
  const allSelected = items.every((x) => x.selected)
  const iconBtn = `inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-700 hover:border-slate-300 disabled:opacity-40 ${FOCUS}`

  return (
    <section aria-labelledby={`${uid}-titre`} className="space-y-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`${uid}-titre`} className="text-sm font-semibold text-slate-900">Organiser les pages · version {revisionNumber}</h2>
        <p className="text-xs text-slate-600">Glisser-déposer, ou au clavier sur une page : flèches pour déplacer, R pour pivoter (Maj+R : sens inverse), Suppr pour retirer, Espace pour sélectionner.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => setItems((xs) => xs.map((x) => ({ ...x, selected: !allSelected })))}>{allSelected ? "Tout désélectionner" : "Tout sélectionner"}</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setItems((xs) => xs.map((x) => (x.selected ? { ...x, rotate: addRotation(x.rotate, 90) } : x)))} disabled={extract.length === 0}><RotateCw aria-hidden="true" className="mr-1 h-4 w-4" />Pivoter la sélection</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setItems((xs) => xs.map((x) => (x.selected ? { ...x, removed: true } : x)))} disabled={extract.length === 0}><Trash2 aria-hidden="true" className="mr-1 h-4 w-4" />Retirer la sélection</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => { setItems(initial()); setAnnounce("Organisation d'origine rétablie.") }}><Undo2 aria-hidden="true" className="mr-1 h-4 w-4" />Tout annuler</Button>
      </div>
      <p className="sr-only" aria-live="polite">{announce}</p>

      <ol className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
        {items.map((it, i) => {
          const pg = pages[it.page - 1]
          return (
            <li key={it.page}
              draggable onDragStart={(e) => { setDragFrom(i); e.dataTransfer.effectAllowed = "move" }} onDragEnd={() => setDragFrom(null)}
              onDragOver={(e) => { if (dragFrom !== null) e.preventDefault() }} onDrop={(e) => { e.preventDefault(); if (dragFrom !== null) move(dragFrom, i); setDragFrom(null) }}
              className={`rounded-lg border p-2 ${it.removed ? "border-dashed border-slate-300 bg-slate-50 opacity-60" : it.selected ? "border-[#0f3460] bg-[#0f3460]/5 ring-1 ring-[#0f3460]" : "border-slate-200 bg-white"} ${dragFrom === i ? "opacity-40" : ""}`}>
              <div id={`${uid}-card-${i}`} tabIndex={0} role="group" onKeyDown={(e) => onKey(e, i)}
                aria-label={`Position ${i + 1} : page ${it.page}${it.rotate ? `, pivotée de ${it.rotate} degrés` : ""}${it.removed ? ", retirée" : ""}${it.selected ? ", sélectionnée" : ""}`}
                className={`cursor-grab rounded ${FOCUS}`}>
                <RotatedThumb doc={doc} n={it.page} pg={pg} rotate={it.rotate} label="" />
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-1">
                <label className="flex items-center gap-1 text-xs text-slate-700">
                  <input type="checkbox" checked={it.selected} onChange={() => set(i, (x) => ({ ...x, selected: !x.selected }))} className="h-3.5 w-3.5" />
                  Page {it.page}
                </label>
                {it.removed ? <span className="text-[11px] font-medium text-red-700">retirée</span> : it.rotate ? <span className="text-[11px] text-slate-500">{it.rotate}°</span> : null}
              </div>
              <div className="mt-1 flex items-center justify-between gap-0.5">
                <button type="button" className={iconBtn} onClick={() => move(i, i - 1)} disabled={i === 0} aria-label={`Déplacer la page ${it.page} avant`}><ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" /></button>
                <button type="button" className={iconBtn} onClick={() => set(i, (x) => ({ ...x, rotate: addRotation(x.rotate, -90) }))} aria-label={`Pivoter la page ${it.page} à gauche`}><RotateCcw aria-hidden="true" className="h-3.5 w-3.5" /></button>
                <button type="button" className={iconBtn} onClick={() => set(i, (x) => ({ ...x, rotate: addRotation(x.rotate, 90) }))} aria-label={`Pivoter la page ${it.page} à droite`}><RotateCw aria-hidden="true" className="h-3.5 w-3.5" /></button>
                <button type="button" className={`${iconBtn} ${it.removed ? "" : "text-red-700"}`} onClick={() => set(i, (x) => ({ ...x, removed: !x.removed }))} aria-label={it.removed ? `Remettre la page ${it.page}` : `Retirer la page ${it.page}`}>{it.removed ? <Undo2 aria-hidden="true" className="h-3.5 w-3.5" /> : <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />}</button>
                <button type="button" className={iconBtn} onClick={() => move(i, i + 1)} disabled={i === items.length - 1} aria-label={`Déplacer la page ${it.page} après`}><ArrowRight aria-hidden="true" className="h-3.5 w-3.5" /></button>
              </div>
            </li>
          )
        })}
      </ol>

      <div className="grid gap-3 border-t border-slate-200 pt-3 lg:grid-cols-2">
        <FormulaireRetour action={organizePdfAction} className="space-y-2 rounded-lg border border-slate-200 p-3">
          <h3 className="text-sm font-semibold text-slate-900">Enregistrer l&apos;organisation</h3>
          <input type="hidden" name="pdfId" value={pdfId} />
          <input type="hidden" name="baseRevisionId" value={revisionId} />
          <input type="hidden" name="plan" value={JSON.stringify(plan)} />
          <p className="text-xs text-slate-600" aria-live="polite">{plan.length === 0 ? "Toutes les pages sont retirées : gardez-en au moins une." : unchanged ? "Aucun changement pour l'instant." : `${plan.length} page${plan.length > 1 ? "s" : ""} dans la version ${revisionNumber + 1}.`}</p>
          {!canSave && saveBlockedReason && <p className="text-xs text-amber-800">{saveBlockedReason}</p>}
          <Button type="submit" disabled={!canSave || plan.length === 0 || unchanged}>Enregistrer la version {revisionNumber + 1}</Button>
        </FormulaireRetour>
        <FormulaireRetour action={extractPagesAction} className="space-y-2 rounded-lg border border-slate-200 p-3">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900"><Scissors aria-hidden="true" className="h-4 w-4" />Extraire dans un nouveau PDF</h3>
          <input type="hidden" name="pdfId" value={pdfId} />
          <input type="hidden" name="revisionId" value={revisionId} />
          <input type="hidden" name="plan" value={JSON.stringify(extract)} />
          <label className="grid gap-1 text-xs text-slate-600">Titre (facultatif)
            <Input name="title" maxLength={160} placeholder={extract.length ? `${title} - pages ${pageRanges(extract.map((x) => x.page))}` : "Sélectionnez des pages"} />
          </label>
          <p className="text-xs text-slate-600" aria-live="polite">{extract.length === 0 ? "Cochez les pages à extraire (ordre et rotation affichés conservés)." : extractAll ? "Toutes les pages sont sélectionnées, sans changement : rien à extraire." : `${extract.length} page${extract.length > 1 ? "s" : ""} sélectionnée${extract.length > 1 ? "s" : ""}.`}</p>
          <Button type="submit" variant="outline" disabled={extract.length === 0 || extractAll}>Extraire {extract.length || ""} page{extract.length > 1 ? "s" : ""}</Button>
        </FormulaireRetour>
      </div>
    </section>
  )
}
