// COMPTABILITÉ A2 — tests unitaires purs des écrans (saisie, montants, CSV, libellés).
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { accountingErrorMessage, amountInputToCents, entryTotals, formatEuros, isCalendarDay, parseEntryForm } from "@/lib/accounting/ui/forms"
import { buildCsv, csvAmount, csvFilename, csvText } from "@/lib/accounting/ui/csv"
import { defaultDayInYear, fiscalYearLabel, pickFiscalYear, searchParam, yearContainingToday } from "@/lib/accounting/ui/labels"

const line = (accountId: string, debit: string, credit: string) => ({ accountId, debit, credit })
const base = { journalId: "j", fiscalYearId: "y", entryDate: "2026-03-01", label: "Achat", lines: [line("a", "10,50", ""), line("b", "", "10,50")] }

describe("montants saisis", () => {
  it("formats acceptés", () => {
    assert.equal(amountInputToCents(""), BigInt(0))
    assert.equal(amountInputToCents("1 234,56"), BigInt(123456))
    assert.equal(amountInputToCents("1 234,5"), BigInt(123450))
    assert.equal(amountInputToCents("12.3"), BigInt(1230))
  })
  it("formats refusés", () => {
    for (const bad of ["-5", "1,234", "abc", "1,2,3", "+3"]) assert.throws(() => amountInputToCents(bad), bad)
  })
  it("affichage exact fr-FR", () => {
    assert.equal(formatEuros(BigInt(123456789)), "1\u202f234\u202f567,89\u00a0€")
    assert.equal(formatEuros(BigInt(-5)), "−0,05\u00a0€")
    assert.equal(formatEuros(BigInt(0)), "0,00\u00a0€")
  })
  it("totaux en direct, saisie invalide signalée", () => {
    assert.deepEqual(entryTotals([{ debit: "10", credit: "" }, { debit: "", credit: "9,99" }]), { debitCents: BigInt(1000), creditCents: BigInt(999), valid: true })
    assert.equal(entryTotals([{ debit: "x", credit: "" }]).valid, false)
  })
})

describe("parseEntryForm", () => {
  it("convertit une saisie valide (dates UTC, champs vides → null)", () => {
    const r = parseEntryForm({ ...base, documentRef: "", documentDate: "" })
    assert.ok(r.ok)
    if (r.ok) {
      assert.equal(r.value.entryDate.toISOString(), "2026-03-01T00:00:00.000Z")
      assert.equal(r.value.documentRef, null); assert.equal(r.value.documentDate, null)
      assert.equal(r.value.lines[0].debitCents, BigInt(1050)); assert.equal(r.value.lines[1].creditCents, BigInt(1050))
    }
  })
  it("refuse champ inconnu (companyId injecté), libellé vide, une seule ligne, montant invalide, date mal formée", () => {
    assert.equal(parseEntryForm({ ...base, companyId: "autre" }).ok, false)
    assert.equal(parseEntryForm({ ...base, label: "  " }).ok, false)
    assert.equal(parseEntryForm({ ...base, lines: [line("a", "1", "")] }).ok, false)
    const bad = parseEntryForm({ ...base, lines: [line("a", "1,234", ""), line("b", "", "1")] })
    assert.deepEqual(bad, { ok: false, error: "Ligne 1 : montant invalide" })
    assert.equal(parseEntryForm({ ...base, entryDate: "01/03/2026" }).ok, false)
  })
})

describe("messages d'erreur", () => {
  it("code connu + détails traduits ; code inconnu ⇒ message générique", () => {
    assert.equal(accountingErrorMessage("ENTRY_INVALID", ["UNBALANCED"]), "Écriture invalide : total débit ≠ total crédit.")
    assert.equal(accountingErrorMessage("XYZ"), "Opération refusée.")
  })
})

describe("CSV", () => {
  it("neutralise les formules et échappe séparateurs/guillemets", () => {
    assert.equal(csvText("=HYPERLINK(\"x\")"), `"'=HYPERLINK(""x"")"`)
    assert.equal(csvText("+33"), "'+33")
    assert.equal(csvText("@cmd"), "'@cmd")
    assert.equal(csvText("a;b"), `"a;b"`)
    assert.equal(csvText("Vente client"), "Vente client")
  })
  it("montants à la virgule, signe ASCII, sans séparateur de milliers", () => {
    assert.equal(csvAmount(BigInt(123456789)), "1234567,89")
    assert.equal(csvAmount(BigInt(-7)), "-0,07")
  })
  it("BOM, CRLF, en-tête, montant négatif non transformé en texte", () => {
    const out = buildCsv(["Compte", "Solde"], [[{ text: "411000" }, { amount: BigInt(-100) }]])
    assert.equal(out, "﻿Compte;Solde\r\n411000;-1,00\r\n")
  })
  it("nom de fichier ASCII sûr", () => {
    assert.equal(csvFilename("grand-livre-411000-2026-01-01"), "grand-livre-411000-2026-01-01")
    assert.equal(csvFilename('ba"lance é/../x'), "ba-lance-e-..-x")
    assert.equal(csvFilename("///"), "export")
  })
})

describe("libellés et paramètres", () => {
  const years = [
    { id: "y2", status: "CLOSING", startDate: new Date("2027-01-01T00:00:00Z"), endDate: new Date("2027-12-31T00:00:00Z") },
    { id: "y1", status: "OPEN", startDate: new Date("2026-01-01T00:00:00Z"), endDate: new Date("2026-12-31T00:00:00Z") },
  ]
  it("exercice demandé, sinon ouvert, sinon le plus récent", () => {
    assert.equal(pickFiscalYear(years, "y2")?.id, "y2")
    assert.equal(pickFiscalYear(years, "inconnu")?.id, "y1")
    assert.equal(pickFiscalYear([years[0]], undefined)?.id, "y2")
    assert.equal(pickFiscalYear([], "y1"), undefined)
  })
  it("libellé d'exercice", () => {
    assert.equal(fiscalYearLabel(years[1]), "01/01/2026 → 31/12/2026 (Ouvert)")
  })
  it("searchParam : chaîne courte uniquement", () => {
    assert.equal(searchParam(" abc "), "abc")
    assert.equal(searchParam(["x", "y"]), "x")
    assert.equal(searchParam(""), undefined)
    assert.equal(searchParam("a".repeat(65)), undefined)
    assert.equal(searchParam(undefined), undefined)
  })
})

describe("dates", () => {
  it("jour calendaire strict", () => {
    assert.equal(isCalendarDay("2026-02-28"), true)
    assert.equal(isCalendarDay("2028-02-29"), true)
    for (const bad of ["2026-02-31", "2026-13-01", "2026-2-1", "01/02/2026", ""]) assert.equal(isCalendarDay(bad), false, bad)
    assert.equal(parseEntryForm({ ...base, entryDate: "2026-02-31" }).ok, false)
  })
  it("jour par défaut : le dernier jour de l'exercice reste dans l'exercice", () => {
    const y = { startDate: new Date("2026-01-01T00:00:00Z"), endDate: new Date("2026-12-31T00:00:00Z") }
    assert.equal(defaultDayInYear(y, new Date("2026-12-31T18:30:00Z")), "2026-12-31")
    assert.equal(defaultDayInYear(y, new Date("2027-01-01T00:00:01Z")), "2026-01-01")
    const y2 = { startDate: new Date("2027-01-01T00:00:00Z"), endDate: new Date("2027-12-31T00:00:00Z") }
    assert.equal(yearContainingToday([y2, y], new Date("2026-12-31T23:00:00Z")), y)
  })
})
