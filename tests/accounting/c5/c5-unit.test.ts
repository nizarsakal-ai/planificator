// Lot C5 — tests unitaires purs : analyse des relevés CSV, analyse OCR, FEC (formats), drapeaux OCR/auto-posting.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { bankFingerprint, guessBankMapping, parseBankAmount, parseBankCsv, parseBankDate, previewCsv } from "@/lib/accounting/c5/bank-import"
import { DisabledOcrProvider, getOcrProvider, parseOcrPayload, setOcrProviderForTests, sniffMime } from "@/lib/accounting/c5/ocr-provider"
import { FEC_HEADER, fecAmount, fecDate, fecText } from "@/lib/accounting/c5/fec"
import { isAccountingAutoPostingEnabled, isBillingOcrEnabled } from "@/lib/billing/billing-feature-flag"

describe("relevés bancaires", () => {
  it("dates et montants français", () => {
    assert.equal(parseBankDate("05/03/2026")?.toISOString(), "2026-03-05T00:00:00.000Z"); assert.equal(parseBankDate("2026-03-05")?.toISOString(), "2026-03-05T00:00:00.000Z"); assert.equal(parseBankDate("31/02/2026"), null); assert.equal(parseBankDate("x"), null)
    assert.equal(parseBankAmount("1 234,56"), BigInt(123456)); assert.equal(parseBankAmount("-12.5"), BigInt(-1250)); assert.equal(parseBankAmount("(12,00)"), BigInt(-1200)); assert.equal(parseBankAmount("12,00 €"), BigInt(1200)); assert.equal(parseBankAmount("1.234,56"), BigInt(123456)); assert.equal(parseBankAmount(""), null); assert.equal(parseBankAmount("abc"), null)
  })
  it("mapping deviné, montant signé ou débit/crédit, empreinte stable, lignes invalides signalées", () => {
    const text = "Date;Libellé;Débit;Crédit;Référence\n05/03/2026;VIR CLIENT A FAC-2026-0001;;1 200,00;REF1\n06/03/2026;PRLV EDF;89,90;;\n07/03/2026;LIGNE CASSÉE;;;\nx;y;;1;"
    const p = previewCsv(text); assert.equal(p.delimiter, ";"); assert.equal(p.header.length, 5)
    const m = guessBankMapping(p.header); assert.deepEqual(m, { date: 0, label: 1, amount: undefined, debit: 2, credit: 3, reference: 4, headerRows: 1 })
    const r = parseBankCsv("co", text, m)
    assert.equal(r.lines.length, 2); assert.equal(r.lines[0].amountCents, BigInt(120000)); assert.equal(r.lines[1].amountCents, BigInt(-8990)); assert.equal(r.lines[0].reference, "REF1")
    assert.deepEqual(r.invalid.map((i) => i.error), ["montant invalide", "date invalide"])
    assert.equal(bankFingerprint("co", r.lines[0].date, r.lines[0].amountCents, "vir client a fac-2026-0001", "ref1"), r.lines[0].fingerprint)
    const single = parseBankCsv("co", "date,libelle,montant\n2026-03-05,Paiement,-15.5", { date: 0, label: 1, amount: 2, headerRows: 1 })
    assert.equal(single.lines[0].amountCents, BigInt(-1550))
  })
})

describe("OCR", () => {
  it("analyse stricte du JSON : SIRET 14 chiffres, montants en centimes, cohérence HT + TVA = TTC, confiance bornée", () => {
    const r = parseOcrPayload('Voici : {"supplier":" Fournisseur X ","siret":"123 456 789 00012","invoiceNumber":"F-12","date":"2026-03-01","amountHT":100,"vatAmount":20,"amountTTC":120.01,"vatRate":"20","supplierType":"services","confidence":{"supplier":0.95,"siret":1.7,"amountHT":"0.5"}}')
    assert.equal(r.supplier, "Fournisseur X"); assert.equal(r.siret, "12345678900012"); assert.equal(r.totalHTCents, BigInt(10000)); assert.equal(r.vatCents, BigInt(2000)); assert.equal(r.totalTTCCents, BigInt(12001)); assert.equal(r.amountsAdjusted, false); assert.equal(r.vatRateBp, 2000); assert.equal(r.category, "services")
    assert.deepEqual(r.confidence, { supplier: 0.95, siret: 1, amountHT: 0.5 })
    const adj = parseOcrPayload('{"amountHT":100,"vatAmount":20,"amountTTC":150,"siret":"123","date":"2026-13-01"}')
    assert.equal(adj.totalTTCCents, BigInt(12000)); assert.equal(adj.amountsAdjusted, true); assert.equal(adj.siret, null); assert.equal(adj.date, null); assert.equal(adj.supplier, null)
    assert.throws(() => parseOcrPayload("pas de json"), (e: unknown) => (e as { code?: string }).code === "OCR_PARSE")
  })
  it("signature binaire des fichiers ; fournisseur désactivé par défaut (jamais d'appel API sans drapeau)", async () => {
    assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg"); assert.equal(sniffMime(Buffer.from("%PDF-1.4")), "application/pdf"); assert.equal(sniffMime(Buffer.from("GIF89a")), null)
    assert.equal(sniffMime(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])), "image/webp")
    assert.equal(isBillingOcrEnabled({ BILLING_OCR_ENABLED: "1" }), false); assert.equal(isAccountingAutoPostingEnabled({}), false)
    setOcrProviderForTests(null)
    assert.equal(getOcrProvider().name, "disabled")
    await assert.rejects(new DisabledOcrProvider().extract(), (e: unknown) => (e as { code?: string }).code === "OCR_DISABLED")
  })
})

describe("FEC", () => {
  it("18 colonnes, dates AAAAMMJJ, montants virgule, texte sans séparateur", () => {
    assert.equal(FEC_HEADER.length, 18)
    assert.equal(fecDate(new Date("2026-03-05T00:00:00Z")), "20260305"); assert.equal(fecAmount(BigInt(123456)), "1234,56"); assert.equal(fecAmount(BigInt(0)), "0,00"); assert.equal(fecAmount(BigInt(-5)), "-0,05")
    assert.equal(fecText("a|b\nc\td"), "a b c d")
  })
})
