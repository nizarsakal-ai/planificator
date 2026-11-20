/**
 * Document Studio — espace PDF (lots 1 et 2, 20/11/2026) : règles PURES, sans accès serveur ni dépendance Node.
 *
 * Lot 1 : un PDF reçu est importé tel quel (révision 1, « original »), jamais modifié ; il est affiché page par page.
 * Lot 2 : « Remplir et signer » produit une NOUVELLE révision à partir de la dernière : textes, dates, coches et
 * signature manuscrite posés à des positions de page. L'original et chaque révision restent intacts et empreints.
 * Lot 3 : « Organiser » produit une nouvelle révision selon un plan de pages (ordre, rotation, pages retirées) ;
 * « Combiner » (plusieurs PDF) et « Extraire » (des pages d'un PDF) créent un NOUVEAU PDF dont les sources sont figées.
 *
 * Coordonnées des éléments : entiers en dix-millièmes de la page TELLE QU'AFFICHÉE (rotation appliquée), origine en haut
 * à gauche, point d'ancrage = coin haut-gauche de l'élément. Tailles de texte en points PDF entiers. Des entiers seulement :
 * la liste des éléments passe par la forme canonique (empreinte) qui refuse les décimaux.
 */

export const PDF_LIMITS = {
  /** Corps de requête : Vercel refuse au-delà de 4,5 Mo ; 4 Mo laissent la marge de l'enveloppe multipart. */
  maxUploadBytes: 4 * 1024 * 1024,
  /**
   * Révision stockée (remplie, réorganisée, combinée) : elle doit rester TÉLÉCHARGEABLE, or Vercel refuse aussi toute
   * réponse de fonction au-delà de 4,5 Mo. Au-delà de cette borne, l'enregistrement est refusé avec un message clair.
   */
  maxStoredBytes: 4_400_000,
  /** Combiner : nombre de PDF assemblés en une fois. */
  maxCombineParts: 20,
  maxPages: 300,
  /** Texte conservé par page pour la recherche (au-delà : tronqué, la page reste trouvable sur son début). */
  maxTextPerPage: 20_000,
  maxOperations: 100,
  maxTextLength: 300,
  minFontSize: 6,
  maxFontSize: 36,
  /** Largeur d'une signature posée : 3 % à 60 % de la largeur de la page. */
  minSignatureWidth: 300,
  maxSignatureWidth: 6000,
  /** Coche : 1 % à 10 % de la largeur de la page. */
  minCheckSize: 100,
  maxCheckSize: 1000,
  maxRevisions: 50,
} as const

export const PDF_UPLOAD_LABEL = "4 Mo"
export const COORD_MAX = 10_000

export const PDF_ERRORS = {
  notFound: "PDF introuvable.",
  noFile: "Choisissez un fichier PDF.",
  tooLarge: `Fichier trop lourd : ${PDF_UPLOAD_LABEL} au maximum.`,
  notPdf: "Ce fichier n'est pas un PDF lisible.",
  tooManyPages: `PDF trop long : ${PDF_LIMITS.maxPages} pages au maximum.`,
  title: "Titre obligatoire (3 à 160 caractères).",
  operations: "Éléments posés invalides : rechargez la page et recommencez.",
  noOperation: "Posez au moins un élément (texte, date, coche ou signature) sur le document.",
  tooManyOperations: `${PDF_LIMITS.maxOperations} éléments au plus par enregistrement.`,
  page: "Un élément est placé sur une page qui n'existe pas.",
  text: `Texte vide ou trop long (${PDF_LIMITS.maxTextLength} caractères au plus).`,
  unsupportedChars: (chars: string[]) => `Caractères non pris en charge par la police du PDF : ${chars.slice(0, 5).map((c) => `« ${c} »`).join(", ")}.`,
  date: "Date invalide.",
  signatureMissing: "Signature absente : signez dans le cadre avant de la poser.",
  signatureUnused: "Une signature a été tracée mais n'est posée nulle part : posez-la ou effacez-la.",
  encrypted: "Ce PDF est protégé (chiffré) : il peut être consulté, mais pas rempli ni signé ici.",
  notLatest: "Une version plus récente existe : rechargez la page, puis recommencez depuis la dernière version.",
  tooManyRevisions: `Nombre maximal de versions atteint (${PDF_LIMITS.maxRevisions}).`,
  outputTooLarge: "Le PDF obtenu serait trop lourd.",
  writeFailed: "Ce PDF n'a pas pu être modifié (structure non prise en charge). L'original est intact.",
  plan: "Plan de pages invalide : rechargez la page et recommencez.",
  planEmpty: "Gardez au moins une page.",
  planUnchanged: "Aucun changement : déplacez, pivotez ou retirez au moins une page.",
  combineParts: `Choisissez de 2 à ${PDF_LIMITS.maxCombineParts} PDF à combiner.`,
  combineDuplicate: "Un même PDF est choisi deux fois.",
  extractEmpty: "Sélectionnez au moins une page à extraire.",
  extractAll: "Toutes les pages sont sélectionnées, dans l'ordre et sans rotation : rien à extraire.",
  sourceMissing: "Un des PDF choisis est introuvable : rechargez la page.",
  sourceEncrypted: "Un des PDF choisis est protégé (chiffré) : ses pages ne peuvent pas être reprises.",
  tooManyPagesOut: `Le PDF obtenu dépasserait ${PDF_LIMITS.maxPages} pages.`,
} as const

export type Plan<T> = { ok: true; value: T } | { ok: false; error: string }
const ko = (error: string): { ok: false; error: string } => ({ ok: false, error })
const okv = <T>(value: T): Plan<T> => ({ ok: true, value })

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

/** Signature binaire d'un PDF (« %PDF- ») dans les 1 024 premiers octets, comme le tolèrent les lecteurs courants. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, Math.min(bytes.length, 1024))
  for (let i = 0; i + 4 < head.length; i++) {
    if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) return true
  }
  return false
}

/** Titre affiché : celui saisi, sinon le nom du fichier sans extension. */
export function validatePdfTitle(raw: string | null | undefined, originalName: string): Plan<string> {
  const base = (raw ?? "").replace(CONTROL, " ").replace(/\s+/g, " ").trim() || originalName.replace(/\.pdf$/i, "").replace(CONTROL, " ").replace(/\s+/g, " ").trim()
  const title = base.slice(0, 160).trim()
  return title.length < 3 ? ko(PDF_ERRORS.title) : okv(title)
}

/** Nom de fichier d'origine conservé pour l'affichage et le téléchargement (sans chemin, borné). */
export function cleanOriginalName(raw: string | null | undefined): string {
  const last = (raw ?? "").split(/[\\/]/).pop() ?? ""
  const n = last.replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, 160)
  return n || "document.pdf"
}

/** Nom de fichier sûr pour l'en-tête Content-Disposition (ASCII). */
export function downloadName(title: string, revision: number): string {
  const ascii = title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9 ._-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").slice(0, 80).replace(/^[-.]+|[-.]+$/g, "")
  return `${ascii || "document"}${revision > 1 ? `-v${revision}` : ""}.pdf`
}

// ── Pages : géométrie lue à l'import ────────────────────────────────────────────────────────────────────────────────

export type Rotation = 0 | 90 | 180 | 270
/** Boîte visible (CropBox) en points, et rotation d'affichage. */
export interface PageGeometry { x: number; y: number; width: number; height: number; rotation: Rotation }

export function normalizeRotation(angle: number): Rotation {
  const r = ((Math.round(angle / 90) * 90) % 360 + 360) % 360
  return r as Rotation
}

/** Taille AFFICHÉE (rotation appliquée), en points. */
export function displaySize(g: PageGeometry): { width: number; height: number } {
  return g.rotation === 90 || g.rotation === 270 ? { width: g.height, height: g.width } : { width: g.width, height: g.height }
}

/** Lecture prudente de la géométrie stockée (JSON). */
export function readPageGeometries(raw: unknown): PageGeometry[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > PDF_LIMITS.maxPages) return null
  const out: PageGeometry[] = []
  for (const p of raw) {
    if (!p || typeof p !== "object") return null
    const { x, y, width, height, rotation } = p as Record<string, unknown>
    if (![x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n))) return null
    if ((width as number) <= 0 || (height as number) <= 0) return null
    if (rotation !== 0 && rotation !== 90 && rotation !== 180 && rotation !== 270) return null
    out.push({ x: x as number, y: y as number, width: width as number, height: height as number, rotation })
  }
  return out
}

/** Géométrie à stocker : nombres arrondis au centième de point (forme stable, sans flottants parasites). */
export const roundGeometry = (g: PageGeometry): PageGeometry => {
  const r = (n: number) => Math.round(n * 100) / 100
  return { x: r(g.x), y: r(g.y), width: r(g.width), height: r(g.height), rotation: g.rotation }
}

/**
 * Point AFFICHÉ (en points, origine en haut à gauche de la page affichée) → point de l'espace PDF de la page.
 * Rotation d'affichage horaire (convention PDF /Rotate) : à 90°, le bord gauche du PDF devient le haut affiché.
 */
export function displayToPdf(g: PageGeometry, dx: number, dy: number): { x: number; y: number } {
  switch (g.rotation) {
    case 0: return { x: g.x + dx, y: g.y + g.height - dy }
    case 90: return { x: g.x + dy, y: g.y + dx }
    case 180: return { x: g.x + g.width - dx, y: g.y + dy }
    case 270: return { x: g.x + g.width - dy, y: g.y + g.height - dx }
  }
}

// ── Lot 2 : éléments posés ──────────────────────────────────────────────────────────────────────────────────────────

export type PdfOperation =
  | { kind: "text"; page: number; x: number; y: number; size: number; text: string }
  | { kind: "date"; page: number; x: number; y: number; size: number; date: string }
  | { kind: "check"; page: number; x: number; y: number; size: number }
  | { kind: "signature"; page: number; x: number; y: number; width: number }

export const OPERATION_KINDS = ["text", "date", "check", "signature"] as const
export type OperationKind = (typeof OPERATION_KINDS)[number]
export const OPERATION_LABEL: Record<OperationKind, string> = { text: "Texte", date: "Date", check: "Coche", signature: "Signature" }

/**
 * Caractères que la police standard Helvetica (codage WinAnsi) sait écrire : ASCII imprimable, Latin-1 imprimable, et
 * les ajouts Windows-1252 (€, guillemets typographiques, tirets, œ…). Le reste est REFUSÉ (jamais remplacé en silence).
 */
const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ")
export function unsupportedChars(text: string): string[] {
  const bad = new Set<string>()
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    const ok = (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.has(ch)
    if (!ok) bad.add(ch)
  }
  return [...bad]
}

/** Texte saisi : NFC, espaces insécables fines ramenées à l'espace insécable, contrôles et retours à la ligne en espaces. */
export function cleanFieldText(raw: string): string {
  return raw.normalize("NFC").replace(/[\u202f\u2007]/g, "\u00a0").replace(CONTROL, " ").replace(/ {2,}/g, " ").trim()
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/
export function isValidDay(s: string): boolean {
  const m = DAY.exec(s)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (y < 1900 || y > 2200) return false
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}
/** Date écrite sur le PDF : JJ/MM/AAAA (forme française courte, comme sur un avis ou un bon). */
export const dayText = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max

/**
 * Lecture et validation de la liste d'éléments envoyée par le navigateur (JSON). Toute forme inattendue est refusée ;
 * aucune clé supplémentaire n'est conservée. `pageCount` borne les numéros de page (1 à n).
 */
export function parseOperations(json: string, pageCount: number): Plan<PdfOperation[]> {
  let raw: unknown
  try { raw = JSON.parse(json) } catch { return ko(PDF_ERRORS.operations) }
  if (!Array.isArray(raw)) return ko(PDF_ERRORS.operations)
  if (raw.length === 0) return ko(PDF_ERRORS.noOperation)
  if (raw.length > PDF_LIMITS.maxOperations) return ko(PDF_ERRORS.tooManyOperations)
  const out: PdfOperation[] = []
  for (const o of raw) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return ko(PDF_ERRORS.operations)
    const r = o as Record<string, unknown>
    if (!isInt(r.page, 1, Number.MAX_SAFE_INTEGER)) return ko(PDF_ERRORS.operations)
    if ((r.page as number) > pageCount) return ko(PDF_ERRORS.page)
    if (!isInt(r.x, 0, COORD_MAX) || !isInt(r.y, 0, COORD_MAX)) return ko(PDF_ERRORS.operations)
    const page = r.page as number, x = r.x as number, y = r.y as number
    if (r.kind === "text") {
      if (!isInt(r.size, PDF_LIMITS.minFontSize, PDF_LIMITS.maxFontSize) || typeof r.text !== "string") return ko(PDF_ERRORS.operations)
      const text = cleanFieldText(r.text)
      if (!text || text.length > PDF_LIMITS.maxTextLength) return ko(PDF_ERRORS.text)
      const bad = unsupportedChars(text)
      if (bad.length) return ko(PDF_ERRORS.unsupportedChars(bad))
      out.push({ kind: "text", page, x, y, size: r.size as number, text })
    } else if (r.kind === "date") {
      if (!isInt(r.size, PDF_LIMITS.minFontSize, PDF_LIMITS.maxFontSize) || typeof r.date !== "string" || !isValidDay(r.date)) return ko(PDF_ERRORS.date)
      out.push({ kind: "date", page, x, y, size: r.size as number, date: r.date })
    } else if (r.kind === "check") {
      if (!isInt(r.size, PDF_LIMITS.minCheckSize, PDF_LIMITS.maxCheckSize)) return ko(PDF_ERRORS.operations)
      out.push({ kind: "check", page, x, y, size: r.size as number })
    } else if (r.kind === "signature") {
      if (!isInt(r.width, PDF_LIMITS.minSignatureWidth, PDF_LIMITS.maxSignatureWidth)) return ko(PDF_ERRORS.operations)
      out.push({ kind: "signature", page, x, y, width: r.width as number })
    } else return ko(PDF_ERRORS.operations)
  }
  return okv(out)
}

export const hasSignature = (ops: readonly PdfOperation[]) => ops.some((o) => o.kind === "signature")

/** Résumé lisible d'un enregistrement (journal, liste des versions). */
export function summarizeOperations(ops: readonly PdfOperation[]): string {
  const n = (k: OperationKind) => ops.filter((o) => o.kind === k).length
  const parts: string[] = []
  const t = n("text"), d = n("date"), c = n("check"), s = n("signature")
  if (t) parts.push(`${t} texte${t > 1 ? "s" : ""}`)
  if (d) parts.push(`${d} date${d > 1 ? "s" : ""}`)
  if (c) parts.push(`${c} coche${c > 1 ? "s" : ""}`)
  if (s) parts.push(`${s} signature${s > 1 ? "s" : ""}`)
  return parts.join(", ")
}

/** Ligne de base d'un texte posé, sous le haut de sa boîte (Helvetica : hauteur des capitales + jambage, ≈ 0,8 em). */
export const TEXT_BASELINE_EM = 0.8

// ── Lot 1 : recherche dans le texte des pages ───────────────────────────────────────────────────────────────────────

export function normalizeSearch(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[\s\u00a0\u202f]+/g, " ").trim()
}

/** Lecture prudente du texte des pages stocké. */
export function readPageTexts(raw: unknown, pageCount: number): string[] {
  if (!Array.isArray(raw)) return Array.from({ length: pageCount }, () => "")
  return Array.from({ length: pageCount }, (_, i) => (typeof raw[i] === "string" ? (raw[i] as string) : ""))
}

export interface SearchHit { page: number; count: number; snippet: string }

/**
 * Recherche insensible à la casse, aux accents et aux espaces multiples. Une page est trouvée si l'expression y figure
 * telle quelle, ou à défaut si TOUS ses mots y figurent (« total eur » trouve « Total : EUR ») ; nombre d'occurrences de
 * l'expression (ou du premier mot à défaut) et extrait autour de la première. Saisie de moins de 2 caractères : rien.
 */
export function searchPages(texts: readonly string[], query: string, maxHits = 100): SearchHit[] {
  const q = normalizeSearch(query.slice(0, 100))
  if (q.length < 2) return []
  const words = q.split(" ").filter(Boolean)
  const hits: SearchHit[] = []
  const occurrences = (hay: string, needle: string) => {
    let count = 0, first = -1, from = 0
    for (;;) {
      const at = hay.indexOf(needle, from)
      if (at < 0) break
      if (first < 0) first = at
      count++
      from = at + needle.length
    }
    return { count, first }
  }
  texts.forEach((raw, i) => {
    if (hits.length >= maxHits) return
    const flat = raw.replace(/[\s\u00a0\u202f]+/g, " ")
    // Normalisation caractère par caractère : longueur conservée (index réutilisables pour l'extrait).
    const perChar = [...flat].map((c) => normalizeSearch(c) || (c === " " ? " " : c)).join("")
    const aligned = perChar.length === flat.length
    const norm = aligned ? perChar : normalizeSearch(flat)
    let { count, first } = occurrences(norm, q)
    let len = q.length
    if (!count) {
      if (words.length < 2 || !words.every((w) => norm.includes(w))) return
      ;({ count, first } = occurrences(norm, words[0]))
      len = words[0].length
    }
    if (!aligned) { hits.push({ page: i + 1, count, snippet: flat.slice(0, 160) }); return }
    const start = Math.max(0, first - 60), end = Math.min(flat.length, first + len + 60)
    hits.push({ page: i + 1, count, snippet: `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}` })
  })
  return hits
}

// ── Lot 3 : organiser, extraire, combiner ───────────────────────────────────────────────────────────────────────────

/** Une page du PDF obtenu : numéro de page SOURCE (1 à n) et rotation AJOUTÉE (quart de tour horaire). */
export interface PlannedPage { page: number; rotate: Rotation }
export type PagePlan = PlannedPage[]

const ROTATIONS: readonly number[] = [0, 90, 180, 270]

/**
 * Plan de pages envoyé par le navigateur : ordre voulu, rotation ajoutée ; une page absente du plan est retirée. Chaque
 * page source au plus une fois ; au moins une page ; aucune clé supplémentaire conservée.
 */
export function parsePagePlan(json: string, pageCount: number): Plan<PagePlan> {
  let raw: unknown
  try { raw = JSON.parse(json) } catch { return ko(PDF_ERRORS.plan) }
  if (!Array.isArray(raw)) return ko(PDF_ERRORS.plan)
  if (raw.length === 0) return ko(PDF_ERRORS.planEmpty)
  if (raw.length > pageCount) return ko(PDF_ERRORS.plan)
  const seen = new Set<number>()
  const out: PagePlan = []
  for (const o of raw) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return ko(PDF_ERRORS.plan)
    const { page, rotate } = o as Record<string, unknown>
    if (!isInt(page, 1, pageCount) || seen.has(page as number)) return ko(PDF_ERRORS.plan)
    if (typeof rotate !== "number" || !ROTATIONS.includes(rotate)) return ko(PDF_ERRORS.plan)
    seen.add(page as number)
    out.push({ page: page as number, rotate: rotate as Rotation })
  }
  return okv(out)
}

/** Plan identique au document (toutes les pages, dans l'ordre, sans rotation). */
export const isIdentityPlan = (plan: readonly PlannedPage[], pageCount: number) =>
  plan.length === pageCount && plan.every((p, i) => p.page === i + 1 && p.rotate === 0)

/** Résumé lisible d'un plan (journal, liste des versions). */
export function summarizePlan(plan: readonly PlannedPage[], pageCount: number): string {
  const removed = pageCount - plan.length
  const rotated = plan.filter((p) => p.rotate !== 0).length
  const kept = plan.map((p) => p.page)
  const moved = kept.some((n, i) => i > 0 && n < kept[i - 1])
  const parts: string[] = []
  if (moved) parts.push("pages réordonnées")
  if (rotated) parts.push(`${rotated} page${rotated > 1 ? "s" : ""} pivotée${rotated > 1 ? "s" : ""}`)
  if (removed) parts.push(`${removed} page${removed > 1 ? "s" : ""} retirée${removed > 1 ? "s" : ""}`)
  return parts.join(", ") || "aucun changement"
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
/** Liste des PDF à combiner (identifiants, dans l'ordre voulu) : 2 à 20, sans doublon. */
export function parseCombineIds(json: string): Plan<string[]> {
  let raw: unknown
  try { raw = JSON.parse(json) } catch { return ko(PDF_ERRORS.combineParts) }
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > PDF_LIMITS.maxCombineParts) return ko(PDF_ERRORS.combineParts)
  if (!raw.every((v) => typeof v === "string" && ID_RE.test(v))) return ko(PDF_ERRORS.combineParts)
  if (new Set(raw).size !== raw.length) return ko(PDF_ERRORS.combineDuplicate)
  return okv(raw as string[])
}

/** Rotation résultante d'une page : rotation d'origine + quart(s) de tour ajouté(s). */
export const addRotation = (current: number, delta: number): Rotation => normalizeRotation(current + delta)

/** Source figée d'un PDF combiné ou extrait. */
export interface PdfSource { pdfId: string; revisionId: string; revision: number; title: string; pages: number[] }

/** Lecture prudente des sources stockées. */
export function readSources(raw: unknown): PdfSource[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((s): s is PdfSource => !!s && typeof s === "object" && typeof (s as PdfSource).pdfId === "string"
    && typeof (s as PdfSource).revisionId === "string" && Number.isSafeInteger((s as PdfSource).revision)
    && typeof (s as PdfSource).title === "string" && Array.isArray((s as PdfSource).pages))
}

/** « 1-3, 5, 7-8 » : pages d'une source, en plages lisibles (ordre conservé). */
export function pageRanges(pages: readonly number[]): string {
  const out: string[] = []
  let i = 0
  while (i < pages.length) {
    let j = i
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++
    out.push(j > i ? `${pages[i]}-${pages[j]}` : String(pages[i]))
    i = j + 1
  }
  return out.join(", ")
}
