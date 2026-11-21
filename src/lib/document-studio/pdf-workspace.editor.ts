/**
 * Document Studio — espace PDF : état PUR de l'éditeur « Remplir et signer » (lot 2), partagé par le composant client et
 * les tests. Aucune dépendance au navigateur. Les éléments sont exprimés comme côté serveur (dix-millièmes de la page
 * affichée, tailles en points) ; `toPayload` produit exactement la liste que `parseOperations` revalide.
 */
import { COORD_MAX, MIN_RECT, PDF_LIMITS, type OperationKind, type PdfOperation } from "@/lib/document-studio/pdf-workspace.core"

export interface EditorItem {
  id: string
  kind: OperationKind
  page: number
  x: number
  y: number
  /** Texte et date : taille en points ; coche : côté en dix-millièmes de largeur. */
  size: number
  /** Signature : largeur en dix-millièmes de largeur de page. */
  width: number
  /** Surligner, encadrer : largeur et hauteur en dix-millièmes de la page. */
  w: number
  h: number
  text: string
  date: string
}

export const DEFAULT_FONT_SIZE = 11
export const DEFAULT_CHECK_SIZE = 250
export const DEFAULT_SIGNATURE_WIDTH = 2200
export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24] as const

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(v)))
export const clampCoord = (v: number) => clamp(v, 0, COORD_MAX)

/** Date du jour à Paris (AAAA-MM-JJ). */
export function parisToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
}

export function newItem(kind: OperationKind, page: number, x: number, y: number, id: string, today: string): EditorItem {
  return {
    id, kind, page, x: clampCoord(x), y: clampCoord(y),
    size: kind === "check" ? DEFAULT_CHECK_SIZE : DEFAULT_FONT_SIZE,
    width: DEFAULT_SIGNATURE_WIDTH, w: MIN_RECT, h: MIN_RECT, text: "", date: today,
  }
}

export const moveItem = (it: EditorItem, x: number, y: number): EditorItem => {
  // Un rectangle reste entièrement dans la page quand on le déplace.
  if (it.kind === "highlight" || it.kind === "box") return { ...it, x: clamp(x, 0, COORD_MAX - it.w), y: clamp(y, 0, COORD_MAX - it.h) }
  return { ...it, x: clampCoord(x), y: clampCoord(y) }
}

/** Rectangle normalisé depuis deux coins (glisser dans n'importe quel sens), borné à la page ; null s'il est trop petit. */
export function rectFromCorners(x1: number, y1: number, x2: number, y2: number): { x: number; y: number; w: number; h: number } | null {
  const ax = clampCoord(Math.min(x1, x2)), ay = clampCoord(Math.min(y1, y2))
  const bx = clampCoord(Math.max(x1, x2)), by = clampCoord(Math.max(y1, y2))
  const w = bx - ax, h = by - ay
  return w >= MIN_RECT && h >= MIN_RECT ? { x: ax, y: ay, w, h } : null
}

export function resizeItem(it: EditorItem, delta: 1 | -1): EditorItem {
  if (it.kind === "signature") return { ...it, width: clamp(it.width + delta * 300, PDF_LIMITS.minSignatureWidth, PDF_LIMITS.maxSignatureWidth) }
  if (it.kind === "check") return { ...it, size: clamp(it.size + delta * 50, PDF_LIMITS.minCheckSize, PDF_LIMITS.maxCheckSize) }
  if (it.kind === "highlight" || it.kind === "box") {
    const f = delta > 0 ? 1.15 : 1 / 1.15
    const w = clamp(it.w * f, MIN_RECT, COORD_MAX - it.x), h = clamp(it.h * f, MIN_RECT, COORD_MAX - it.y)
    return { ...it, w, h }
  }
  const i = FONT_SIZES.findIndex((s) => s >= it.size)
  const next = FONT_SIZES[Math.min(FONT_SIZES.length - 1, Math.max(0, (i < 0 ? FONT_SIZES.length - 1 : i) + delta))]
  return { ...it, size: next }
}

/** Liste envoyée au serveur (les textes vides sont ignorés : un champ posé puis laissé vide ne produit rien). */
export function toPayload(items: readonly EditorItem[]): PdfOperation[] {
  const out: PdfOperation[] = []
  for (const it of items) {
    const base = { page: it.page, x: clampCoord(it.x), y: clampCoord(it.y) }
    if (it.kind === "text") { const t = it.text.trim(); if (t) out.push({ kind: "text", ...base, size: it.size, text: t }) }
    else if (it.kind === "date") out.push({ kind: "date", ...base, size: it.size, date: it.date })
    else if (it.kind === "check") out.push({ kind: "check", ...base, size: it.size })
    else if (it.kind === "highlight" || it.kind === "box") out.push({ kind: it.kind, ...base, w: it.w, h: it.h })
    else if (it.kind === "note") { const t = it.text.trim(); if (t) out.push({ kind: "note", ...base, size: it.size, text: t }) }
    else out.push({ kind: "signature", ...base, width: it.width })
  }
  return out
}
