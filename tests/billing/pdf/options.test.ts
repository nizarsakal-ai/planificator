/**
 * Options de facture (21/11/2026) — preuves exécutables : langue anglaise (libellés et mentions standard, textes saisis
 * inchangés, mention « la version française fait foi »), adresse de livraison, intitulé libre, saisie « absent ≠ vide ».
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React from "react"
import { renderToBuffer } from "@react-pdf/renderer"
import { extractText, getDocumentProxy } from "unpdf"
import { DocumentPdf } from "@/lib/billing/pdf/DocumentPdf"
import type { DocumentPdfData } from "@/lib/billing/pdf/document-data"
import { DEFAULT_PDF_DESIGN, designFromSnapshot, validateDesign, type PdfDesign } from "@/lib/billing/pdf/design"
import { buildDesignPreviewData } from "@/lib/billing/pdf/design-preview"
import { FRENCH_PREVAILS_EN, translate } from "@/lib/billing/pdf/pdf-i18n"
import { DEFAULT_LATE_PENALTY_TEXT } from "@/lib/billing/settings"
import { REVERSE_CHARGE_MENTION, VAT_EXEMPT_MENTION } from "@/lib/billing/pdf/document-data"
import { parseInvoiceForm } from "@/lib/billing/invoices/invoice-schemas"

;(globalThis as { React?: typeof React }).React = React

async function pdfText(data: DocumentPdfData): Promise<string> {
  const buf = await renderToBuffer(DocumentPdf({ data }))
  const { text } = await extractText(await getDocumentProxy(new Uint8Array(buf)), { mergePages: true })
  return text
}
const IDENTITY = { seller: { name: "GALYA EVENTS", lines: ["17 Place du Général de Gaulle 93100 Montreuil"] }, logoDataUrl: null, legalFooter: "GALYA EVENTS", bank: null }
const design = (p: Partial<PdfDesign> = {}): PdfDesign => ({ ...DEFAULT_PDF_DESIGN, ...p })
const sample = (d: PdfDesign, over: Partial<DocumentPdfData> = {}) => ({ ...buildDesignPreviewData(d, IDENTITY), ...over })

describe("traduction", () => {
  it("français : toujours inchangé", () => {
    assert.equal(translate("FACTURE", "FR"), "FACTURE")
    assert.equal(translate(DEFAULT_LATE_PENALTY_TEXT, "FR"), DEFAULT_LATE_PENALTY_TEXT)
  })
  it("anglais : titres, libellés, motifs et mentions légales standard", () => {
    assert.equal(translate("FACTURE", "EN"), "INVOICE")
    assert.equal(translate("FACTURE (brouillon — non émise)", "EN"), "INVOICE (draft — not issued)")
    assert.equal(translate("TVA 5,5 %", "EN"), "VAT 5,5 %")
    assert.equal(translate("Paiement à 30 jours.", "EN"), "Payment within 30 days.")
    assert.equal(translate("Conditions de paiement : à réception", "EN"), "Payment terms: à réception", "le texte saisi après le libellé n'est pas traduit")
    assert.match(translate(DEFAULT_LATE_PENALTY_TEXT, "EN"), /^Late payment: penalties/)
    assert.match(translate(REVERSE_CHARGE_MENTION, "EN"), /^Reverse charge/)
    assert.match(translate(VAT_EXEMPT_MENTION, "EN"), /^VAT not applicable/)
    assert.match(translate(`Entre professionnels : ${DEFAULT_LATE_PENALTY_TEXT}`, "EN"), /^Between professionals: Late payment/)
  })
  it("texte inconnu (saisi par l'utilisateur) : inchangé", () => {
    assert.equal(translate("Prestation électrique — installation scène", "EN"), "Prestation électrique — installation scène")
  })
})

describe("design : nouvelles options", () => {
  it("valeurs par défaut pour une saisie ou un snapshot antérieurs", () => {
    const v = validateDesign({ template: "MODERN", primary: "#4f46e5", secondary: "#4338ca", layout: "COMPLETE", showClientIds: true, showBankDetails: false })
    assert.ok(v.ok)
    if (v.ok) { assert.equal(v.design.language, "FR"); assert.equal(v.design.showDeliveryAddress, true) }
    assert.equal(designFromSnapshot({ template: "BAND", primary: "#047857", secondary: "#065f46" }).language, "FR")
  })
  it("langue inconnue refusée", () => {
    assert.equal(validateDesign({ template: "MODERN", primary: "#4f46e5", secondary: "#4338ca", layout: "COMPLETE", showClientIds: true, showBankDetails: false, language: "DE" }).ok, false)
  })
})

describe("rendu réel", () => {
  it("anglais : libellés traduits, désignations inchangées, mention « la version française fait foi »", async () => {
    const txt = await pdfText(sample(design({ template: "MODERN", language: "EN" })))
    for (const needle of ["INVOICE", "Total incl. VAT", "Issue date", "DELIVERY ADDRESS", "Prestation électrique", "French version prevails"]) assert.ok(txt.includes(needle), `« ${needle} » absent`)
    assert.equal(txt.includes("Total TTC"), false)
    assert.ok(FRENCH_PREVAILS_EN.includes("French version prevails"))
  })
  it("français par défaut : aucun libellé anglais", async () => {
    const txt = await pdfText(sample(design({ template: "MODERN" })))
    assert.ok(txt.includes("Total TTC") && !txt.includes("Total incl. VAT") && !txt.includes("French version prevails"))
  })
  it("adresse de livraison : affichée sur option, masquée sinon, absente si non renseignée", async () => {
    assert.ok((await pdfText(sample(design({ template: "BAND" })))).includes("3 allée des Livraisons"))
    assert.equal((await pdfText(sample(design({ template: "BAND", showDeliveryAddress: false })))).includes("3 allée des Livraisons"), false)
    assert.equal((await pdfText(sample(design({ template: "BAND" }), { deliveryAddress: null }))).toUpperCase().includes("ADRESSE DE LIVRAISON"), false)
  })
  it("intitulé libre sous le titre légal, sur chaque modèle", async () => {
    for (const template of ["CLASSIC", "MODERN", "BAND", "MINIMAL"] as const) {
      const txt = await pdfText(sample(design({ template }), { subtitle: "Facture de situation n° 2" }))
      // Titre espacé (Épuré) : extrait lettre par lettre ⇒ comparaison sans espaces.
      assert.ok(txt.replace(/\s/g, "").includes("FACTURE") && txt.includes("Facture de situation n° 2"), template)
    }
  })
  it("tableau propre au document et totaux masqués (bon de livraison)", async () => {
    const txt = await pdfText(sample(design({ template: "MODERN" }), {
      title: "BON DE LIVRAISON", hideTotals: true, signatureKind: "delivery", signature: null,
      table: { columns: [{ key: "d", label: "Désignation", width: 60 }, { key: "o", label: "Qté commandée", width: 20, numeric: true }, { key: "l", label: "Qté livrée", width: 20, numeric: true }], rows: [{ cells: { d: "Câble 25 m", o: "4", l: "3" } }] },
    }))
    assert.ok(txt.includes("Câble 25 m") && txt.includes("Qté livrée") && txt.includes("Réception de la livraison"), txt.slice(0, 400))
    assert.equal(txt.includes("Total TTC"), false)
  })
})

describe("saisie de facture : adresse de livraison et intitulé", () => {
  const base = { worksiteId: "w1", lines: [{ designation: "P", quantity: "1", unitPrice: "100", vatRate: "20" }] }
  it("absent ⇒ non écrit ; vide ⇒ effacé ; sinon valeur sans espaces de bord", () => {
    const absent = parseInvoiceForm(base); assert.ok(absent.ok)
    if (absent.ok) { assert.equal(absent.value.deliveryAddress, undefined); assert.equal(absent.value.documentTitle, undefined) }
    const empty = parseInvoiceForm({ ...base, deliveryAddress: "  ", documentTitle: "" }); assert.ok(empty.ok)
    if (empty.ok) { assert.equal(empty.value.deliveryAddress, null); assert.equal(empty.value.documentTitle, null) }
    const set = parseInvoiceForm({ ...base, deliveryAddress: " 3 allée X ", documentTitle: " Situation 2 " }); assert.ok(set.ok)
    if (set.ok) { assert.equal(set.value.deliveryAddress, "3 allée X"); assert.equal(set.value.documentTitle, "Situation 2") }
  })
  it("longueurs bornées", () => {
    assert.equal(parseInvoiceForm({ ...base, documentTitle: "x".repeat(121) }).ok, false)
    assert.equal(parseInvoiceForm({ ...base, deliveryAddress: "x".repeat(501) }).ok, false)
  })
})
