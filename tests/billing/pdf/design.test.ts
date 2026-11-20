/**
 * Modèles de design des PDF (20/11/2026) — preuves exécutables.
 *  - logique pure : couleurs, contraste, palettes lisibles, résolution (document ?? société ?? défaut), lecture défensive
 *    du snapshot, format Rapide (quantité 1 sans remise seulement), identifiants client, tampon de statut ;
 *  - rendu réel @react-pdf des 4 modèles (texte extrait) : contenu identique, « Classique » par défaut = rendu historique,
 *    format Rapide et repli Complet, encadré bancaire sans doublon de mention, identifiants client masquables, tampon.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React from "react"
import { renderToBuffer } from "@react-pdf/renderer"
import { extractText, getDocumentProxy } from "unpdf"
import { DocumentPdf } from "@/lib/billing/pdf/DocumentPdf"
import type { DocumentPdfData, PdfLine } from "@/lib/billing/pdf/document-data"
import {
  DEFAULT_PDF_DESIGN, MIN_CONTRAST, PDF_PALETTES, PDF_TEMPLATES, buyerLinesFor, contrastRatio, designFromSnapshot, designFromStored, designToStored,
  effectiveLayout, invoiceStamp, normalizeHex, quickLayoutAllowed, resolveDesign, tint, validateDesign, type PdfDesign, type StoredDesign,
} from "@/lib/billing/pdf/design"
import { buildDesignPreviewData } from "@/lib/billing/pdf/design-preview"

;(globalThis as { React?: typeof React }).React = React

const design = (p: Partial<PdfDesign> = {}): PdfDesign => ({ ...DEFAULT_PDF_DESIGN, ...p })
const input = (p: Partial<Record<keyof PdfDesign, unknown>> = {}) => ({ ...DEFAULT_PDF_DESIGN, ...p }) as Parameters<typeof validateDesign>[0]
const EMPTY: StoredDesign = { pdfTemplate: null, pdfPrimaryColor: null, pdfSecondaryColor: null, pdfLayout: null, pdfShowClientIds: null, pdfShowBankDetails: null }

describe("couleurs et contraste", () => {
  it("normalise les codes hexadécimaux et refuse le reste", () => {
    assert.equal(normalizeHex("#ABCDEF"), "#abcdef")
    assert.equal(normalizeHex(" 0f3460 "), "#0f3460")
    for (const bad of ["#abc", "#12345g", "rgb(0,0,0)", "", "#1234567"]) assert.equal(normalizeHex(bad), null, bad)
  })
  it("contraste WCAG : noir/blanc = 21, identique = 1", () => {
    assert.equal(Math.round(contrastRatio("#000000", "#ffffff")), 21)
    assert.equal(contrastRatio("#0f3460", "#0f3460"), 1)
  })
  it("teinte : 0 = blanc, 1 = couleur pure ; hors bornes refusé", () => {
    assert.equal(tint("#0f3460", 0), "#ffffff")
    assert.equal(tint("#0f3460", 1), "#0f3460")
    assert.throws(() => tint("#0f3460", 1.2), RangeError)
  })
  it("toutes les palettes prêtes sont lisibles (texte blanc sur la principale, secondaire sur blanc)", () => {
    for (const p of PDF_PALETTES) {
      assert.ok(contrastRatio(p.primary, "#ffffff") >= MIN_CONTRAST, `${p.id} principale`)
      assert.ok(contrastRatio(p.secondary, "#ffffff") >= MIN_CONTRAST, `${p.id} secondaire`)
      assert.ok(validateDesign(input({ primary: p.primary, secondary: p.secondary })).ok, p.id)
    }
  })
})

describe("validation d'un design", () => {
  it("accepte un design complet et normalise les couleurs", () => {
    const v = validateDesign(input({ template: "MODERN", primary: "#4F46E5", secondary: "4338ca", layout: "QUICK", showBankDetails: true }))
    assert.ok(v.ok)
    assert.deepEqual(v.design, { template: "MODERN", primary: "#4f46e5", secondary: "#4338ca", layout: "QUICK", showClientIds: true, showBankDetails: true })
  })
  it("refuse modèle / format inconnus et couleurs invalides", () => {
    const v = validateDesign(input({ template: "FANCY", layout: "TINY", primary: "bleu", secondary: "#12" }))
    assert.equal(v.ok, false)
    if (!v.ok) assert.equal(v.errors.length, 4)
  })
  it("refuse une couleur trop claire (illisible) — principale et secondaire", () => {
    const v = validateDesign(input({ primary: "#a5b4fc", secondary: "#fde68a" }))
    assert.equal(v.ok, false)
    if (!v.ok) { assert.match(v.errors[0], /principale trop claire/); assert.match(v.errors[1], /secondaire trop claire/) }
  })
  it("refuse des options non booléennes", () => {
    assert.equal(validateDesign(input({ showClientIds: "oui" })).ok, false)
  })
})

describe("résolution du design", () => {
  const company: StoredDesign = { pdfTemplate: "BAND", pdfPrimaryColor: "#047857", pdfSecondaryColor: "#065f46", pdfLayout: "COMPLETE", pdfShowClientIds: true, pdfShowBankDetails: true }
  const doc: StoredDesign = { pdfTemplate: "MODERN", pdfPrimaryColor: "#4f46e5", pdfSecondaryColor: "#4338ca", pdfLayout: "QUICK", pdfShowClientIds: false, pdfShowBankDetails: false }
  it("document ?? société ?? défaut historique", () => {
    assert.equal(resolveDesign(doc, company).template, "MODERN")
    assert.equal(resolveDesign(EMPTY, company).template, "BAND")
    assert.deepEqual(resolveDesign(EMPTY, null), DEFAULT_PDF_DESIGN)
  })
  it("une valeur stockée corrompue n'est jamais appliquée (niveau suivant)", () => {
    assert.equal(resolveDesign({ ...doc, pdfPrimaryColor: "#ffffff" }, company).template, "BAND", "couleur illisible")
    assert.equal(designFromStored({ ...doc, pdfTemplate: "INCONNU" }), null)
  })
  it("aller-retour colonnes ↔ design", () => {
    const d = resolveDesign(doc, null)
    assert.deepEqual(designFromStored(designToStored(d)), d)
  })
  it("snapshot : lecture défensive, absent ou invalide ⇒ Classique historique ; options manquantes ⇒ valeurs par défaut", () => {
    assert.deepEqual(designFromSnapshot(undefined), DEFAULT_PDF_DESIGN)
    assert.deepEqual(designFromSnapshot({ template: "MODERN", primary: 12 }), DEFAULT_PDF_DESIGN)
    assert.deepEqual(designFromSnapshot({ template: "MINIMAL", primary: "#9f1239", secondary: "#be123c" }), { ...DEFAULT_PDF_DESIGN, template: "MINIMAL", primary: "#9f1239", secondary: "#be123c" })
  })
})

describe("format Rapide, identifiants client, tampon", () => {
  const l = (quantity: string, discount = "") => ({ quantity, discount })
  it("Rapide seulement si toutes les lignes ont une quantité de 1 et aucune remise", () => {
    assert.ok(quickLayoutAllowed([l("1"), l("1,00")]))
    assert.equal(quickLayoutAllowed([l("1"), l("2")]), false)
    assert.equal(quickLayoutAllowed([l("1", "10 %")]), false)
    assert.equal(quickLayoutAllowed([]), false)
    assert.equal(effectiveLayout(design({ layout: "QUICK" }), [l("3")]), "COMPLETE", "repli : aucune information obligatoire masquée")
    assert.equal(effectiveLayout(design({ layout: "QUICK" }), [l("1")]), "QUICK")
  })
  it("identifiants client masquables, adresse et e-mail conservés", () => {
    const lines = ["1 rue X", "SIRET 12345678900012", "TVA intracommunautaire FR12123456789", "a@b.fr"]
    assert.deepEqual(buyerLinesFor(lines, false), ["1 rue X", "a@b.fr"])
    assert.deepEqual(buyerLinesFor(lines, true), lines)
  })
  it("tampon : Payée / Annulée sur les factures, jamais sur un avoir ni une facture ouverte", () => {
    assert.deepEqual(invoiceStamp("PAID", "INVOICE"), { label: "Payée", tone: "success" })
    assert.deepEqual(invoiceStamp("CANCELLED", "DEPOSIT"), { label: "Annulée", tone: "danger" })
    assert.equal(invoiceStamp("PAID", "CREDIT_NOTE"), null)
    assert.equal(invoiceStamp("SENT", "INVOICE"), null)
  })
})

// ── Rendu réel ──────────────────────────────────────────────────────────────────────────────────────────────────────
async function pdfText(data: DocumentPdfData): Promise<string> {
  const buf = await renderToBuffer(DocumentPdf({ data }))
  const pdf = await getDocumentProxy(new Uint8Array(buf))
  const { text } = await extractText(pdf, { mergePages: true })
  return text
}
const IDENTITY = { seller: { name: "GALYA EVENTS", lines: ["17 Place du Général de Gaulle 93100 Montreuil", "SIRET 99288525100015"] }, logoDataUrl: null, legalFooter: "GALYA EVENTS — SIRET 99288525100015", bank: { iban: "FR7630006000011234567890189", bic: "AGRIFRPP" } }
const sample = (d: PdfDesign) => buildDesignPreviewData(d, IDENTITY)
const count = (hay: string, needle: string) => hay.split(needle).length - 1

describe("rendu réel des 4 modèles", () => {
  it("chaque modèle rend le même contenu essentiel (parties, lignes, totaux, mentions, pied de page)", async () => {
    for (const template of PDF_TEMPLATES) {
      const txt = await pdfText(sample(design({ template, primary: "#4f46e5", secondary: "#4338ca" })))
      for (const needle of ["GALYA EVENTS", "CLIENT EXEMPLE", "Prestation électrique", "9 077,60 €", "1 512,93 €", "Total TTC", "EXEMPLE-0001 — page 1 / 1", "pénalités"]) assert.ok(txt.includes(needle), `${template} : « ${needle} » absent`)
    }
  })
  it("Classique avec le design par défaut = rendu historique (texte identique avec ou sans design)", async () => {
    const data = sample(DEFAULT_PDF_DESIGN)
    const { design: _d, stamp: _s, ...legacy } = data
    void _d; void _s
    assert.equal(await pdfText(data), await pdfText({ ...legacy, stamp: data.stamp }))
  })
  it("tampon « Payée » sur les modèles récents, jamais sur Classique", async () => {
    assert.ok((await pdfText(sample(design({ template: "MODERN" })))).includes("Payée"))
    assert.ok((await pdfText(sample(design({ template: "BAND" })))).includes("Payée"))
    assert.equal((await pdfText(sample(design({ template: "CLASSIC" })))).includes("Payée"), false)
  })
  it("format Rapide : pas de colonnes Qté / PU ; repli Complet si une ligne a une quantité ≠ 1", async () => {
    const quick = await pdfText(sample(design({ template: "MODERN", layout: "QUICK" })))
    assert.ok(quick.includes("Montant HT") && !quick.includes("PU HT") && !quick.includes("Qté"))
    const data = sample(design({ template: "MODERN", layout: "QUICK" }))
    const lines: PdfLine[] = data.lines.map((x, i) => (i === 0 ? { ...x, quantity: "2" } : x))
    const fallback = await pdfText({ ...data, lines })
    assert.ok(fallback.includes("PU HT") && fallback.includes("Qté"), "repli Complet : quantité et prix unitaire affichés")
  })
  it("colonne Remise masquée sur les modèles récents si aucune remise, conservée sur Classique", async () => {
    assert.equal((await pdfText(sample(design({ template: "MINIMAL" })))).includes("Remise"), false)
    assert.ok((await pdfText(sample(design({ template: "CLASSIC" })))).includes("Remise"))
  })
  it("encadré bancaire : affiché sur option, l'IBAN n'apparaît qu'une fois (mention remplacée) ; sans option, mention seule", async () => {
    const on = await pdfText(sample(design({ template: "BAND", showBankDetails: true })))
    assert.ok(on.includes("Coordonnées bancaires".toUpperCase()) || on.includes("Coordonnées bancaires"))
    assert.equal(count(on, "FR7630006000011234567890189"), 1)
    const off = await pdfText(sample(design({ template: "BAND", showBankDetails: false })))
    assert.equal(off.includes("Titulaire"), false)
    assert.equal(count(off, "FR7630006000011234567890189"), 1)
  })
  it("identifiants client masqués sur option (SIRET et TVA du client absents, adresse conservée)", async () => {
    const txt = await pdfText(sample(design({ template: "MODERN", showClientIds: false })))
    assert.ok(txt.includes("12 rue de l'Exemple") || txt.includes("12 rue de l’Exemple"))
    assert.equal(txt.includes("12345678900012"), false)
    assert.equal(txt.includes("FR12123456789"), false)
  })
  it("document multi-pages : en-tête de tableau répété et pagination sur chaque modèle", async () => {
    const base = sample(design())
    const many: PdfLine[] = Array.from({ length: 70 }, (_, i) => ({ ...base.lines[0], designation: `Ligne ${i + 1}` }))
    for (const template of PDF_TEMPLATES) {
      const buf = await renderToBuffer(DocumentPdf({ data: { ...base, lines: many, design: design({ template }) } }))
      const pdf = await getDocumentProxy(new Uint8Array(buf))
      const { text } = await extractText(pdf, { mergePages: false })
      assert.ok(text.length >= 2, `${template} : plusieurs pages`)
      for (const page of text) assert.ok(page.includes("Désignation") || page.toUpperCase().includes("DÉSIGNATION"), `${template} : en-tête répété`)
      assert.ok(text[text.length - 1].includes(`page ${text.length} / ${text.length}`))
    }
  })
})
