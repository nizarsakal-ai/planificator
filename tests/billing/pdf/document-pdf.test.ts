/**
 * Mission devis / identité / présentation PDF (29/10/2026) — preuves exécutables.
 *
 *  - séparateurs monétaires : rendu réel @react-pdf puis extraction du texte (unpdf) : aucun « / » parasite entre
 *    chiffres, milliers/euros/accents restitués, signe moins sûr ;
 *  - mise en page : description longue, devis multi-pages (en-tête de tableau répété, pagination), logo présent /
 *    absent / transparent, deux entreprises sans fuite d'identité ;
 *  - mentions : B2B (indemnité 40 €) vs B2C, devis déjà émis inchangé (legacy), autoliquidation et franchise
 *    uniquement sur décision explicite ;
 *  - identité émetteur : contrôle de complétude, pied de page sans texte générique, TVA client = SIRET refusée ;
 *  - logo : validation du type réel (sharp), bornes, data URL PNG, téléchargement.
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React from "react"
import { renderToBuffer } from "@react-pdf/renderer"
import { extractText, getDocumentProxy } from "unpdf"
import sharp from "sharp"
import { Prisma } from "@prisma/client"
import { DocumentPdf } from "@/lib/billing/pdf/DocumentPdf"
import { pdfSafe, UNSAFE_PDF_CHARS } from "@/lib/billing/pdf/pdf-text"
import { buyerIsBusiness, buyerParty, legalMentions, linesAndTotals, sellerParty, QUOTE_ACCEPTANCE_MENTION, REVERSE_CHARGE_MENTION, VAT_EXEMPT_MENTION, type DocumentPdfData } from "@/lib/billing/pdf/document-data"
import { assessIssuerIdentity, isPlausibleVatNumber, issuerLegalFooter, vatMatchesSiren } from "@/lib/billing/company-identity"
import { formatEuro } from "@/lib/billing/money"
import { DEFAULT_BILLING_SETTINGS, DEFAULT_LATE_PENALTY_TEXT, type BillingSettingsView } from "@/lib/billing/settings"
import { LOGO_DATA_URL_PREFIX, LOGO_MAX_UPLOAD_BYTES, isManagedLogo, logoDataUrlToPng, logoForPdf, normalizeCompanyLogo } from "@/lib/company-logo"

// tsconfig "jsx": "preserve" → sous tsx, le JSX est compilé en React.createElement (runtime classique) — convention du dépôt.
;(globalThis as { React?: typeof React }).React = React

// ---- Outils ----------------------------------------------------------------------------------------

async function pdfPages(data: DocumentPdfData): Promise<string[]> {
  const buf = await renderToBuffer(DocumentPdf({ data }))
  const pdf = await getDocumentProxy(new Uint8Array(buf))
  const { text } = await extractText(pdf, { mergePages: false })
  return text
}

const dec = (v: string) => new Prisma.Decimal(v)
const line = (designation: string, quantity: string, unitPrice: string, over: Partial<{ description: string | null; unit: string; vatRate: string; discountBp: number }> = {}) => ({
  designation, description: over.description ?? null, unit: over.unit ?? "U", quantity: dec(quantity), unitPrice: dec(unitPrice), vatRate: dec(over.vatRate ?? "20"), lineHT: dec("0"), discountBp: over.discountBp ?? 0,
})

const GALYA = { name: "GALYA EVENTS", address: "17 Place Du Générale De Gaule 93100 Montreuil", siret: "99288525100015", email: "contactgalyaprod@gmail.com", phone: null }
const SETTINGS_FULL: BillingSettingsView = { ...DEFAULT_BILLING_SETTINGS, legalForm: "SAS", shareCapital: "1 000 €", rcs: "RCS Bobigny 992 885 251", vatNumber: "FR00992885251" }
const LAURALU = { name: "LAURALU Tempasset", address: "23 Rue de l'Avenir 09700 Saverdun", siret: "51123355300011", vatNumber: "51123355300011", email: "comptafournisseur@lauralu.fr" }

/** Le cas fourni (DEV-2026-0001) : 5 × 2 000 € + 1 800 × 0,85 € = 11 530 € HT, TVA 20 % = 2 306 €, TTC 13 836 €. */
function devCase(over: Partial<DocumentPdfData> = {}): DocumentPdfData {
  const { pdfLines, totals } = linesAndTotals([line("POSE BATISTOCK", "5", "2000", { description: "10X40H6" }), line("Frais Kilométriques", "1800", "0.85", { description: "MONTREUIL CANNES", unit: "u" })], 0, false)
  return {
    title: "DEVIS", number: "DEV-2026-0001",
    meta: [{ label: "Date", value: "29/10/2026" }, { label: "Valable jusqu'au", value: "29/11/2026" }, { label: "Chantier", value: "PGS" }],
    seller: sellerParty(GALYA, SETTINGS_FULL), buyer: buyerParty(LAURALU), subject: "PGS", lines: pdfLines, totals,
    mentions: legalMentions(SETTINGS_FULL, { vatReverseCharge: false, paymentTerms: null, kind: "quote", buyerIsBusiness: buyerIsBusiness(LAURALU), validUntil: "29/11/2026" }),
    notes: null, footer: null, signature: null, legalFooter: issuerLegalFooter({ ...GALYA, settings: SETTINGS_FULL }), logoDataUrl: null,
    ...over,
  }
}

async function syntheticLogo(width: number, height: number, alpha = false): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: alpha ? { r: 15, g: 52, b: 96, alpha: 0.5 } : { r: 15, g: 52, b: 96, alpha: 1 } } }).png().toBuffer()
}

// ---- 1. Texte sûr ----------------------------------------------------------------------------------

describe("pdf-text — caractères hors WinAnsi", () => {
  it("formatEuro produit une espace fine (U+202F) et un signe moins (U+2212) que les polices standard ne rendent pas", () => {
    const s = formatEuro(BigInt(200000))
    assert.match(s, UNSAFE_PDF_CHARS)
    assert.doesNotMatch(pdfSafe(s), UNSAFE_PDF_CHARS)
    assert.equal(pdfSafe(s), "2 000,00 €")
    assert.equal(pdfSafe(formatEuro(BigInt(-150))), "-1,50 €")
  })
  it("ne touche ni aux slashs ni aux accents ni aux guillemets", () => {
    const s = "Pose 10X40H6 / lot A — « été » œuvre 2/3 → fin"
    assert.equal(pdfSafe(s), "Pose 10X40H6 / lot A — « été » œuvre 2/3 – fin")
  })
})

// ---- 2. Rendu réel ---------------------------------------------------------------------------------

describe("DocumentPdf — rendu réel et extraction de texte", () => {
  it("cas DEV-2026-0001 : montants sans slash parasite, milliers/euros/accents, totaux cohérents, mentions B2B, pied de page d'identité", async () => {
    const pages = await pdfPages(devCase())
    assert.equal(pages.length, 1)
    const text = pages[0]
    assert.doesNotMatch(text, /\d\/\d{3},\d{2}/, "aucun séparateur de milliers rendu en «/»")
    for (const expected of ["2 000,00 €", "10 000,00 €", "1 530,00 €", "11 530,00 €", "2 306,00 €", "13 836,00 €"]) {
      assert.ok(text.replace(/ /g, " ").includes(expected), `montant attendu « ${expected} »`)
    }
    assert.ok(text.includes("Frais Kilométriques") && text.includes("Générale"), "accents conservés")
    assert.ok(text.includes("10X40H6") && text.includes("MONTREUIL CANNES"), "descriptions multilignes")
    assert.ok(text.includes("Entre professionnels") && text.includes("40 €"), "indemnité forfaitaire B2B présente")
    assert.ok(text.includes("Validité de l'offre : jusqu'au 29/11/2026"))
    assert.ok(text.includes("SIRET 51123355300011") && !text.includes("TVA intracommunautaire 51123355300011"), "le SIRET du client n'est pas restitué comme numéro de TVA")
    // Le pied de page peut être replié sur deux lignes par l'extraction : comparaison après normalisation des blancs.
    assert.ok(text.replace(/\s+/g, " ").includes("GALYA EVENTS — SAS au capital de 1 000 € — 17 Place Du Générale De Gaule 93100 Montreuil — SIRET 99288525100015 — RCS Bobigny 992 885 251 — TVA FR00992885251"), "pied de page = identité exacte")
    assert.ok(text.includes("page 1 / 1"))
    assert.ok(text.includes(QUOTE_ACCEPTANCE_MENTION.slice(0, 40)))
  })

  it("description longue : pas de troncature, ligne insécable", async () => {
    const long = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(12).trim()
    const { pdfLines, totals } = linesAndTotals([line("Prestation détaillée", "1", "1234.5", { description: long })], 0, false)
    const pages = await pdfPages(devCase({ lines: pdfLines, totals }))
    assert.ok(pages[0].includes("adipiscing elit"), "description longue rendue")
    assert.ok(pages[0].replace(/ /g, " ").includes("1 234,50 €"))
  })

  it("devis multi-pages (45 lignes) : en-tête de tableau répété, totaux après les lignes, pagination x / N sur chaque page", async () => {
    const lines = Array.from({ length: 45 }, (_, i) => line(`Ligne ${i + 1} — article ${i + 1}`, "2", String(1000 + i), { description: i % 3 === 0 ? "Détail sur deux lignes, avec précisions utiles." : null }))
    const { pdfLines, totals } = linesAndTotals(lines, 0, false)
    const pages = await pdfPages(devCase({ lines: pdfLines, totals }))
    assert.ok(pages.length >= 2, `attendu ≥ 2 pages, obtenu ${pages.length}`)
    for (const [i, p] of pages.entries()) {
      // L'en-tête `fixed` du tableau se répète sur chaque page où le tableau continue (pages portant des lignes).
      if (p.includes("Ligne ")) assert.ok(p.includes("Désignation") && p.includes("PU HT"), `en-tête du tableau présent page ${i + 1}`)
      assert.ok(p.includes(`page ${i + 1} / ${pages.length}`), `pagination page ${i + 1}`)
      assert.ok(p.includes("GALYA EVENTS — SAS"), `pied de page identité page ${i + 1}`)
    }
    assert.ok(pages.filter((p) => p.includes("Ligne ")).length >= 2, "le tableau s'étend sur au moins deux pages, en-tête répété")
    // Les totaux suivent la dernière ligne (sur la même page ou la suivante) ; conditions et signature peuvent s'étendre ensuite.
    const lastLinePage = pages.map((p) => p.includes("Ligne ")).lastIndexOf(true)
    const totalsPage = pages.findIndex((p) => p.includes("Total TTC"))
    assert.ok(totalsPage >= lastLinePage, "les totaux viennent après les lignes")
    assert.equal(pages.filter((p) => p.includes("Total TTC")).length, 1, "totaux imprimés une seule fois")
    assert.doesNotMatch(pages.join("\n"), /\d\/\d{3},\d{2}/)
  })

  it("logo géré présent : image embarquée (dénomination restituée par le bloc émetteur) ; absent : dénomination en en-tête ; logo transparent accepté", async () => {
    const png = await syntheticLogo(400, 120)
    const n = await normalizeCompanyLogo(png)
    assert.ok(n.ok)
    const withLogo = await renderToBuffer(DocumentPdf({ data: devCase({ logoDataUrl: n.ok ? n.dataUrl : null }) }))
    const without = await renderToBuffer(DocumentPdf({ data: devCase({ logoDataUrl: null }) }))
    assert.ok(withLogo.length > without.length + 500, "le PDF avec logo embarque l'image")
    const textWith = (await extractText(await getDocumentProxy(new Uint8Array(withLogo)), { mergePages: false })).text[0]
    assert.ok(textWith.includes("GALYA EVENTS"), "l'identité textuelle reste présente avec le logo")
    const transparent = await normalizeCompanyLogo(await syntheticLogo(300, 100, true))
    assert.ok(transparent.ok)
    const t = await renderToBuffer(DocumentPdf({ data: devCase({ logoDataUrl: transparent.ok ? transparent.dataUrl : null }) }))
    assert.ok(t.length > without.length)
  })

  it("deux entreprises : chaque document ne contient que l'identité et le logo de son émetteur", async () => {
    const other = { name: "ENTREPRISE B CONFIDENTIELLE", address: "1 rue Secrète 59000 Lille", siret: "12345678900011", email: "b@example.test", phone: null }
    const settingsB: BillingSettingsView = { ...DEFAULT_BILLING_SETTINGS, legalForm: "SARL", rcs: "RCS Lille 123 456 789", vatNumber: "FR00123456789" }
    const a = (await pdfPages(devCase())).join("\n")
    const b = (await pdfPages(devCase({ seller: sellerParty(other, settingsB), legalFooter: issuerLegalFooter({ ...other, settings: settingsB }) }))).join("\n")
    assert.ok(a.includes("GALYA EVENTS") && !a.includes("CONFIDENTIELLE") && !a.includes("12345678900011"))
    assert.ok(b.includes("ENTREPRISE B CONFIDENTIELLE") && !b.includes("GALYA") && !b.includes("99288525100015"))
  })

  it("pied de page sans donnée d'identité : rien de générique ; brouillon : données manquantes signalées sur le document", async () => {
    const bare = { name: "Nouvelle Entreprise", address: null, siret: null, email: null, phone: null }
    const assessment = assessIssuerIdentity({ ...bare, settings: DEFAULT_BILLING_SETTINGS })
    const pages = await pdfPages(devCase({ title: "DEVIS (brouillon)", seller: sellerParty(bare, DEFAULT_BILLING_SETTINGS), legalFooter: issuerLegalFooter({ ...bare, settings: DEFAULT_BILLING_SETTINGS }), draftWarnings: assessment.blocking.map((l) => `Donnée d'identité manquante ou invalide : ${l}`) }))
    const text = pages[0]
    assert.ok(text.toUpperCase().includes("BROUILLON — À COMPLÉTER AVANT ÉMISSION"), "titre de section (rendu en capitales)")
    assert.ok(text.includes("Adresse du siège") && text.includes("SIRET") && text.includes("Forme juridique"))
    assert.ok(!/Soci[ée]t[ée] au capital/.test(text), "aucune mention générique inventée")
  })
})

// ---- 3. Mentions et identité -----------------------------------------------------------------------

describe("legalMentions — devis", () => {
  it("B2B : conditions de retard et indemnité de 40 € ; B2C : aucune indemnité ; devis gratuit dans les deux cas", () => {
    const b2b = legalMentions(SETTINGS_FULL, { vatReverseCharge: false, paymentTerms: null, kind: "quote", buyerIsBusiness: true, validUntil: "29/11/2026" })
    assert.ok(b2b.some((m) => m.includes(DEFAULT_LATE_PENALTY_TEXT)))
    const b2c = legalMentions(SETTINGS_FULL, { vatReverseCharge: false, paymentTerms: null, kind: "quote", buyerIsBusiness: false, validUntil: "29/11/2026" })
    assert.ok(!b2c.some((m) => m.includes("40 €")))
    assert.ok(b2c.includes(QUOTE_ACCEPTANCE_MENTION) && b2b.includes(QUOTE_ACCEPTANCE_MENTION))
    assert.ok(b2c.some((m) => m.startsWith("Conditions de paiement : paiement à 30 jours")))
  })
  it("devis déjà émis (legacy) : mentions historiques à l'identique", () => {
    assert.deepEqual(legalMentions(SETTINGS_FULL, { vatReverseCharge: false, paymentTerms: "30 % à la commande", kind: "quote", legacy: true }), ["Conditions de paiement : 30 % à la commande", QUOTE_ACCEPTANCE_MENTION])
    assert.deepEqual(legalMentions(SETTINGS_FULL, { vatReverseCharge: false, paymentTerms: null, kind: "quote", legacy: true }), [QUOTE_ACCEPTANCE_MENTION])
  })
  it("autoliquidation et franchise : uniquement sur décision explicite, jamais parce que le client est européen", () => {
    const eu = { ...LAURALU, vatNumber: "DE123456789", siret: null }
    const plain = legalMentions(SETTINGS_FULL, { vatReverseCharge: false, paymentTerms: null, kind: "quote", buyerIsBusiness: buyerIsBusiness(eu) })
    assert.ok(!plain.includes(REVERSE_CHARGE_MENTION) && !plain.includes(VAT_EXEMPT_MENTION))
    const rc = legalMentions(SETTINGS_FULL, { vatReverseCharge: true, paymentTerms: null, kind: "quote", buyerIsBusiness: true })
    assert.equal(rc[0], REVERSE_CHARGE_MENTION)
    const exempt = legalMentions({ ...SETTINGS_FULL, vatNumber: null }, { vatReverseCharge: false, paymentTerms: null, kind: "quote", vatExempt: true })
    assert.ok(exempt.includes(VAT_EXEMPT_MENTION))
  })
  it("TVA multi-taux : une ligne par taux, bases distinctes", () => {
    const { totals } = linesAndTotals([line("A", "1", "100", { vatRate: "20" }), line("B", "1", "100", { vatRate: "10" }), line("C", "1", "50", { vatRate: "5.5" })], 0, false)
    // Ordre croissant des taux et libellé « 5.5 » : comportement existant de money.ts (hors périmètre de cette mission).
    assert.deepEqual(totals.vat.map((v) => v.label), ["TVA 5.5 %", "TVA 10 %", "TVA 20 %"])
    assert.equal(pdfSafe(totals.totalTTC), "282,75 €")
  })
})

describe("buyerParty / identité client", () => {
  it("SIREN et SIRET distingués ; un SIRET dans le champ TVA n'est pas imprimé comme TVA", () => {
    assert.deepEqual(buyerParty(LAURALU).lines, ["23 Rue de l'Avenir 09700 Saverdun", "SIRET 51123355300011", "comptafournisseur@lauralu.fr"])
    assert.deepEqual(buyerParty({ ...LAURALU, siret: "511233553", vatNumber: "FR22511233553" }).lines, ["23 Rue de l'Avenir 09700 Saverdun", "SIREN 511233553", "TVA intracommunautaire FR22511233553", "comptafournisseur@lauralu.fr"])
    assert.equal(buyerIsBusiness(LAURALU), true)
    assert.equal(buyerIsBusiness({ siret: null, vatNumber: null }), false)
    assert.equal(buyerIsBusiness({ siret: null, vatNumber: "51123355300011" }), false)
  })
  it("isPlausibleVatNumber / vatMatchesSiren", () => {
    assert.equal(isPlausibleVatNumber("FR22511233553"), true)
    assert.equal(isPlausibleVatNumber("fr22 511 233 553"), true)
    assert.equal(isPlausibleVatNumber("51123355300011"), false)
    assert.equal(isPlausibleVatNumber("FR123"), false)
    assert.equal(isPlausibleVatNumber("DE123456789"), true)
    assert.equal(vatMatchesSiren("FR22511233553", "51123355300011"), true)
    assert.equal(vatMatchesSiren("FR22511233554", "51123355300011"), false)
    assert.equal(vatMatchesSiren("DE123456789", "51123355300011"), null)
  })
})

describe("assessIssuerIdentity / issuerLegalFooter", () => {
  it("identité complète ⇒ aucun bloquant ; manquante ⇒ libellés exacts ; TVA absente ⇒ avertissement, TVA = SIRET ⇒ invalide", () => {
    const full = assessIssuerIdentity({ ...GALYA, settings: SETTINGS_FULL })
    assert.deepEqual(full.blocking, [])
    const partial = assessIssuerIdentity({ ...GALYA, settings: DEFAULT_BILLING_SETTINGS })
    assert.deepEqual(partial.blocking, ["Forme juridique", "Immatriculation (RCS / RM)"])
    assert.deepEqual(partial.warnings, ["TVA intracommunautaire"])
    const bad = assessIssuerIdentity({ ...GALYA, siret: "9928852", settings: { ...SETTINGS_FULL, vatNumber: "99288525100015" } })
    assert.ok(bad.blocking.includes("SIRET") && bad.blocking.includes("TVA intracommunautaire"))
    const mismatch = assessIssuerIdentity({ ...GALYA, settings: { ...SETTINGS_FULL, vatNumber: "FR00123456789" } })
    assert.ok(mismatch.blocking.includes("TVA intracommunautaire"))
  })
  it("pied de page : données présentes seulement, jamais de texte générique", () => {
    assert.equal(issuerLegalFooter({ ...GALYA, settings: DEFAULT_BILLING_SETTINGS }), "GALYA EVENTS — 17 Place Du Générale De Gaule 93100 Montreuil — SIRET 99288525100015")
    assert.equal(issuerLegalFooter({ name: "  ", address: null, siret: null, email: null, phone: null, settings: DEFAULT_BILLING_SETTINGS }), null)
    assert.equal(issuerLegalFooter({ ...GALYA, siret: "992885251", settings: { ...DEFAULT_BILLING_SETTINGS, vatNumber: "99288525100015" } }), "GALYA EVENTS — 17 Place Du Générale De Gaule 93100 Montreuil — SIREN 992885251", "une TVA invalide n'est pas imprimée")
  })
})

// ---- 4. Logo ---------------------------------------------------------------------------------------

describe("normalizeCompanyLogo — type réel, bornes, data URL", () => {
  it("PNG, JPEG et WebP acceptés (type réel), normalisés en PNG data URL téléchargeable", async () => {
    for (const fmt of ["png", "jpeg", "webp"] as const) {
      const src = await sharp({ create: { width: 640, height: 200, channels: 3, background: "#0f3460" } })[fmt]().toBuffer()
      const r = await normalizeCompanyLogo(src)
      assert.ok(r.ok, `format ${fmt}`)
      assert.equal(r.sourceFormat, fmt)
      assert.ok(r.dataUrl.startsWith(LOGO_DATA_URL_PREFIX))
      const png = logoDataUrlToPng(r.dataUrl)
      assert.ok(png && png.length === r.bytes)
      assert.ok(isManagedLogo(r.dataUrl) && logoForPdf(r.dataUrl) === r.dataUrl)
    }
  })
  it("redimensionnement borné 1200×480 sans agrandissement ; orientation conservée", async () => {
    const big = await normalizeCompanyLogo(await syntheticLogo(3000, 600))
    assert.ok(big.ok && big.width === 1200 && big.height === 240)
    const small = await normalizeCompanyLogo(await syntheticLogo(100, 40))
    assert.ok(small.ok && small.width === 100 && small.height === 40)
  })
  it("refus : fichier texte renommé, SVG, image trop petite, fichier vide, trop volumineux", async () => {
    assert.deepEqual(await normalizeCompanyLogo(Buffer.from("<html>pas une image</html>")), { ok: false, error: "Format non reconnu : le fichier n'est pas une image PNG, JPEG ou WebP." })
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><script>alert(1)</script></svg>')
    const rs = await normalizeCompanyLogo(svg)
    assert.ok(!rs.ok && /Format non (accept|reconnu)/.test(rs.error))
    const tiny = await normalizeCompanyLogo(await syntheticLogo(10, 10))
    assert.ok(!tiny.ok && tiny.error.includes("trop petite"))
    assert.deepEqual(await normalizeCompanyLogo(Buffer.alloc(0)), { ok: false, error: "Fichier vide." })
    const huge = await normalizeCompanyLogo(Buffer.alloc(LOGO_MAX_UPLOAD_BYTES + 1, 1))
    assert.ok(!huge.ok && huge.error.includes("2 Mo"))
  })
  it("URL externe ou valeur non PNG : non gérée (ni téléchargeable ni embarquée)", () => {
    assert.equal(logoDataUrlToPng("https://res.cloudinary.com/x/logo.png"), null)
    assert.equal(logoDataUrlToPng("data:image/png;base64,QUJD"), null)
    assert.equal(logoForPdf("https://example.test/logo.png"), null)
    assert.equal(isManagedLogo(null), false)
  })
})
