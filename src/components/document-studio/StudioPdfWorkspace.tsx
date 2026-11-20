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
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react"
import { Calendar, Check, Download, Eye, Minus, Move, PenLine, Plus, Signature, Trash2, Type, ZoomIn, ZoomOut } from "lucide-react"
import { loadPdfDocument, type PdfDocument, type PdfLoadingTask, type PdfRenderTask } from "@/components/hr-documents/PdfCanvasPreview"
import { StudioSignatureField } from "@/components/document-studio/StudioSignatureField"
import { FormulaireRetour } from "@/components/crm/RetourFormulaire"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { fillSignPdfAction } from "@/lib/actions/document-studio.actions"
import { COORD_MAX, OPERATION_LABEL, PDF_LIMITS, dayText, unsupportedChars, type OperationKind } from "@/lib/document-studio/pdf-workspace.core"
import { moveItem, newItem, parisToday, resizeItem, toPayload, type EditorItem } from "@/lib/document-studio/pdf-workspace.editor"

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
}

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const
const MAX_PAGE_PIXELS = 8_000_000
const LOAD_TIMEOUT_MS = 30_000
const INK = "#0f2154"
const TOOL_ICON: Record<OperationKind, typeof Type> = { text: Type, date: Calendar, check: Check, signature: Signature }
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

let seq = 0
const nextId = () => `el${Date.now().toString(36)}${(seq++).toString(36)}`

export function StudioPdfWorkspace(p: StudioPdfWorkspaceProps) {
  const uid = useId()
  const load = usePdfDocument(p.fileUrl)
  const doc = load.status === "ready" ? load.doc : null
  const [zoom, setZoom] = useState<number>(1)
  const [mode, setMode] = useState<"view" | "edit">("view")
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
  const badChars = useMemo(() => [...new Set(items.filter((i) => i.kind === "text").flatMap((i) => unsupportedChars(i.text)))], [items])

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
  }, [p.pages.length])

  const goTo = (n: number) => {
    const el = scroller.current?.querySelector<HTMLElement>(`#page-${n}`)
    el?.scrollIntoView({ block: "start", behavior: "auto" })
    el?.focus({ preventScroll: true })
  }
  const zoomBy = (d: 1 | -1) => setZoom((z) => { const i = ZOOMS.findIndex((v) => v >= z); return ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, i + d))] })
  const update = useCallback((id: string, f: (it: EditorItem) => EditorItem) => setItems((xs) => xs.map((x) => (x.id === id ? f(x) : x))), [])
  const remove = useCallback((id: string) => { setItems((xs) => xs.filter((x) => x.id !== id)); setSelected(null) }, [])

  const placeAt = (e: ReactPointerEvent<HTMLDivElement>, page: number) => {
    if (mode !== "edit" || !tool || e.target !== e.currentTarget) { if (e.target === e.currentTarget) setSelected(null); return }
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
    if (it.kind === "text") {
      return (
        <div key={it.id} {...common} className={`absolute rounded-sm bg-sky-100/40 ${ring} ${FOCUS}`} style={{ ...pos, fontSize, lineHeight: 1 }}>
          <button type="button" aria-label="Déplacer" title="Déplacer" onPointerDown={(e) => startDrag(e, it)} onPointerMove={onDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
            className="absolute -left-5 top-0 flex h-4 w-4 cursor-move touch-none items-center justify-center rounded bg-[#0f3460] text-white"><Move aria-hidden="true" className="h-3 w-3" /></button>
          <input value={it.text} maxLength={PDF_LIMITS.maxTextLength} aria-label={`Texte page ${it.page}`} placeholder="Saisir…"
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
  return (
    <div className="space-y-3">
      {/* Barre d'outils */}
      <div role="toolbar" aria-label="Outils de la visionneuse" className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-2 shadow-sm">
        <div className="flex items-center gap-1" role="group" aria-label="Mode">
          <Button type="button" size="sm" variant={editing ? "outline" : "default"} aria-pressed={!editing} onClick={() => { setMode("view"); setTool(null) }}><Eye aria-hidden="true" className="mr-1 h-4 w-4" />Consulter</Button>
          <Button type="button" size="sm" variant={editing ? "default" : "outline"} aria-pressed={editing} disabled={!p.editable} onClick={() => setMode("edit")} title={p.editBlockedReason ?? undefined}><PenLine aria-hidden="true" className="mr-1 h-4 w-4" />Remplir et signer</Button>
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

      <div className={`grid gap-3 ${editing ? "lg:grid-cols-[8rem_minmax(0,1fr)_19rem]" : "lg:grid-cols-[8rem_minmax(0,1fr)]"}`}>
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
                  {editing && (
                    <div data-overlay="" onPointerDown={(e) => placeAt(e, n)} className={`absolute inset-0 ${tool ? "cursor-crosshair" : ""}`} style={{ containerType: "inline-size" }}>
                      {items.filter((it) => it.page === n).map((it) => renderItem(it, pg))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* Panneau « Remplir et signer » */}
        {editing && (
          <aside aria-labelledby={`${uid}-fs`} className="space-y-4 rounded-xl border border-slate-200 bg-white p-3 shadow-sm lg:max-h-[78vh] lg:overflow-y-auto">
            <h2 id={`${uid}-fs`} className="text-sm font-semibold text-slate-900">Remplir et signer</h2>
            <div>
              <p className="mb-1.5 text-xs text-slate-600">Choisissez un outil puis cliquez sur la page à l&apos;endroit voulu.</p>
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
                  <span className="min-w-10 text-center text-xs tabular-nums text-slate-700">{sel.kind === "signature" ? `${Math.round(sel.width / 100)} %` : sel.kind === "check" ? `${Math.round(sel.size / 10) / 10} %` : `${sel.size} pt`}</span>
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
