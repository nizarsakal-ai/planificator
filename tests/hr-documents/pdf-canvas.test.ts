import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  createPdfCanvasSession, pageGeometry, PDF_CANVAS_MESSAGES, PDF_PREVIEW_LIMITS,
  type PdfDocument, type PdfLoader, type PdfLoadingTask, type PdfPage, type PdfRenderState, type PdfPreviewLimits,
} from "../../src/components/hr-documents/PdfCanvasPreview"

// Données synthétiques uniquement : aucun document ni salarié réel. Aucun PDF.js réel n'est chargé ici.
type FakeCanvas = { width: number; height: number; style: { width: string; height: string }; removed: boolean; getContext: (id: string) => object | null; remove: () => void }
function canvasFactory(withContext = true) {
  const made: FakeCanvas[] = []
  const create = () => {
    const c: FakeCanvas = { width: 0, height: 0, style: { width: "", height: "" }, removed: false, getContext: () => (withContext ? {} : null), remove() { this.removed = true } }
    made.push(c); return c as unknown as HTMLCanvasElement
  }
  return { made, create }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
function fakeDoc(pages: number, opts: { size?: { width: number; height: number }; hold?: Promise<void> } = {}) {
  const size = opts.size ?? { width: 595, height: 842 } // A4 en points
  const log = { rendered: [] as number[], cancelled: 0, destroyed: 0, cleaned: 0 }
  const doc: PdfDocument = {
    numPages: pages,
    async getPage(n) {
      const page: PdfPage = {
        getViewport: ({ scale }) => ({ width: size.width * scale, height: size.height * scale }),
        render: () => ({ promise: (opts.hold ?? Promise.resolve()).then(() => { log.rendered.push(n) }), cancel: () => { log.cancelled++ } }),
        cleanup: () => { log.cleaned++ },
      }
      return page
    },
    destroy: () => { log.destroyed++ },
  }
  return { doc, log }
}
/** Tâche de chargement simulée : compte les destroy() ; promesse fournie ou résolue avec le document. */
function task(promise: Promise<PdfDocument>) { const t = { destroyed: 0, promise, destroy: () => { t.destroyed++ } }; return t }
const ok = (doc: PdfDocument): PdfLoader => () => task(Promise.resolve(doc))
const pdfBlob = (bytes = 64) => new Blob([new Uint8Array(bytes).fill(37)], { type: "application/pdf" })
function run(load: PdfLoader, limits: PdfPreviewLimits = PDF_PREVIEW_LIMITS, withContext = true) {
  const states: PdfRenderState[] = [], pages: number[] = [], canvases = canvasFactory(withContext)
  const session = createPdfCanvasSession({ load, createCanvas: canvases.create, onState: s => states.push(s), onPage: (_c, n) => pages.push(n), limits })
  return { session, states, pages, canvases }
}

describe("aperçu PDF r1 : rendu canvas local, borné, annulable, sans téléchargement", () => {
  it("rend chaque page dans l'ordre, une à la fois, et annonce l'état prêt", async () => {
    const { doc, log } = fakeDoc(3); const received: Uint8Array[] = []
    const r = run(data => { received.push(data); return task(Promise.resolve(doc)) })
    await r.session.render(pdfBlob(16), 800, 1)
    assert.deepEqual(r.pages, [1, 2, 3]); assert.deepEqual(log.rendered, [1, 2, 3]); assert.equal(log.cleaned, 3)
    assert.deepEqual(r.states.at(-1), { status: "ready", shown: 3, total: 3 })
    assert.equal(received.length, 1); assert.equal(received[0].length, 16, "octets transmis en mémoire au chargeur local")
    assert.equal(r.canvases.made.length, 3); assert.equal(r.canvases.made[0].style.width, "800px")
  })
  it("limite de pages : au-delà de maxPages, rendu arrêté et pages restantes signalées", async () => {
    const { doc } = fakeDoc(25)
    const r = run(ok(doc))
    await r.session.render(pdfBlob(), 800, 1)
    assert.equal(r.pages.length, PDF_PREVIEW_LIMITS.maxPages)
    assert.deepEqual(r.states.at(-1), { status: "ready", shown: 20, total: 25 })
    assert.match(PDF_CANVAS_MESSAGES.truncated(20, 25), /20 premières pages sur 25/)
  })
  it("budget mémoire total : rendu arrêté avant de dépasser maxTotalPixels", async () => {
    const { doc } = fakeDoc(10)
    const limits = { ...PDF_PREVIEW_LIMITS, maxTotalPixels: 2_500_000 }
    const r = run(ok(doc), limits)
    await r.session.render(pdfBlob(), 800, 1) // 800 × 1132 px ≈ 0,9 Mpx par page
    assert.equal(r.pages.length, 2)
    assert.deepEqual(r.states.at(-1), { status: "ready", shown: 2, total: 10 })
  })
  it("géométrie : largeur et densité plafonnées, pixels par page dans la borne", () => {
    const g = pageGeometry({ width: 595, height: 842 }, 3000, 3)!
    assert.equal(g.cssWidth, PDF_PREVIEW_LIMITS.maxCssWidth)
    assert.ok(g.output <= PDF_PREVIEW_LIMITS.maxOutputScale)
    assert.ok(g.pixelWidth * g.pixelHeight <= PDF_PREVIEW_LIMITS.maxPagePixels)
    const tall = pageGeometry({ width: 100, height: 5000 }, 960, 2)!
    assert.ok(tall.pixelWidth * tall.pixelHeight <= PDF_PREVIEW_LIMITS.maxPagePixels, "page très haute : densité réduite")
    assert.equal(pageGeometry({ width: 0, height: 842 }, 800, 1), null)
    assert.equal(pageGeometry({ width: 595, height: 842 }, 0, Number.NaN)!.cssWidth, PDF_PREVIEW_LIMITS.maxCssWidth)
  })
  it("fichier trop volumineux : message, chargeur jamais appelé", async () => {
    let calls = 0
    const r = run(() => { calls++; return task(Promise.resolve(fakeDoc(1).doc)) })
    await r.session.render(pdfBlob(PDF_PREVIEW_LIMITS.maxBytes + 1), 800, 1)
    assert.equal(calls, 0)
    assert.deepEqual(r.states.at(-1), { status: "error", message: PDF_CANVAS_MESSAGES.tooLarge })
    assert.match(PDF_CANVAS_MESSAGES.tooLarge, /Rien n’a été téléchargé/)
  })
  it("PDF illisible : message de repli, canvas libérés, document détruit", async () => {
    const r = run(() => task(Promise.reject(new Error("InvalidPDFException"))))
    await r.session.render(pdfBlob(), 800, 1)
    assert.deepEqual(r.states.at(-1), { status: "error", message: PDF_CANVAS_MESSAGES.failed })
    assert.match(PDF_CANVAS_MESSAGES.failed, /Rien n’a été téléchargé/)
    const { doc, log } = fakeDoc(2)
    const failing: PdfDocument = { ...doc, getPage: async n => { if (n === 2) throw new Error("page"); return doc.getPage(n) } }
    const r2 = run(ok(failing))
    await r2.session.render(pdfBlob(), 800, 1)
    assert.equal(r2.states.at(-1)?.status, "error")
    assert.ok(r2.canvases.made.every(c => c.width === 0 && c.height === 0 && c.removed), "page déjà rendue libérée")
    assert.equal(log.destroyed, 1)
  })
  it("contexte 2D indisponible : repli sans exception", async () => {
    const r = run(ok(fakeDoc(1).doc), PDF_PREVIEW_LIMITS, false)
    await r.session.render(pdfBlob(), 800, 1)
    assert.deepEqual(r.states.at(-1), { status: "error", message: PDF_CANVAS_MESSAGES.failed })
  })
  it("délai dépassé puis résolution tardive : tâche détruite une fois, document tardif détruit EXACTEMENT une fois", async () => {
    let resolveLate!: (d: PdfDocument) => void
    const t = task(new Promise<PdfDocument>(res => { resolveLate = res }))
    const { doc, log } = fakeDoc(2)
    const r = run(() => t, { ...PDF_PREVIEW_LIMITS, timeoutMs: 10 })
    await r.session.render(pdfBlob(), 800, 1)
    assert.deepEqual(r.states.at(-1), { status: "error", message: PDF_CANVAS_MESSAGES.failed })
    assert.equal(t.destroyed, 1)
    resolveLate(doc); await new Promise(res => setTimeout(res, 5))
    assert.equal(log.destroyed, 1, "document arrivé après le délai : détruit une seule fois")
    r.session.dispose(); await new Promise(res => setTimeout(res, 5))
    assert.equal(t.destroyed, 1); assert.equal(log.destroyed, 1); assert.deepEqual(r.pages, [])
  })
  it("fermeture pendant le rendu : tâche annulée, document détruit, canvas libérés, plus aucun état publié", async () => {
    const hold = deferred(); const { doc, log } = fakeDoc(3, { hold: hold.promise })
    const r = run(ok(doc))
    const pending = r.session.render(pdfBlob(), 800, 1)
    await new Promise(res => setTimeout(res, 5))
    const before = r.states.length
    r.session.dispose()
    hold.resolve(); await pending
    assert.equal(log.cancelled, 1); assert.equal(log.destroyed, 1)
    assert.deepEqual(r.pages, []); assert.equal(r.states.length, before)
    assert.ok(r.canvases.made.every(c => c.width === 0 && c.removed))
  })
  it("fermeture pendant le chargement : tâche détruite aussitôt, document tardif détruit une fois, rien rendu", async () => {
    let resolveLoad!: (d: PdfDocument) => void
    const t = task(new Promise<PdfDocument>(res => { resolveLoad = res }))
    const { doc, log } = fakeDoc(2)
    const r = run(() => t)
    const pending = r.session.render(pdfBlob(), 800, 1)
    await new Promise(res => setTimeout(res, 5))
    r.session.dispose()
    assert.equal(t.destroyed, 1, "chargement interrompu dès la fermeture, sans attendre sa résolution")
    resolveLoad(doc); await pending; await new Promise(res => setTimeout(res, 5))
    assert.equal(log.destroyed, 1); assert.deepEqual(r.pages, []); assert.equal(r.canvases.made.length, 0)
    r.session.dispose(); assert.equal(t.destroyed, 1); assert.equal(log.destroyed, 1)
  })
  it("getPage sans réponse : borné par le délai, document détruit une fois, repli", async () => {
    const { doc, log } = fakeDoc(3)
    const stuck: PdfDocument = { ...doc, getPage: async n => n === 1 ? doc.getPage(1) : new Promise<PdfPage>(() => {}) }
    const r = run(ok(stuck), { ...PDF_PREVIEW_LIMITS, timeoutMs: 10 })
    await r.session.render(pdfBlob(), 800, 1)
    assert.deepEqual(r.states.at(-1), { status: "error", message: PDF_CANVAS_MESSAGES.failed })
    assert.equal(log.destroyed, 1); assert.ok(r.canvases.made.every(c => c.width === 0 && c.removed))
  })
  it("dessin sans fin : tâche de rendu annulée au délai, puis repli", async () => {
    const { doc, log } = fakeDoc(1, { hold: new Promise<void>(() => {}) })
    const r = run(ok(doc), { ...PDF_PREVIEW_LIMITS, timeoutMs: 10 })
    await r.session.render(pdfBlob(), 800, 1)
    assert.equal(log.cancelled, 1); assert.equal(log.destroyed, 1)
    assert.deepEqual(r.states.at(-1), { status: "error", message: PDF_CANVAS_MESSAGES.failed })
  })
  it("le chargeur réel expose une tâche annulable (destroy de PDF.js conservé), sans réseau", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("src/components/hr-documents/PdfCanvasPreview.tsx", "utf8")
    assert.match(src, /return \{ promise, destroy: \(\) => \{ abandoned = true; return task\?\.destroy\(\) \} \}/)
    assert.match(src, /LIMITE ASSUMÉE/)
  })
})
