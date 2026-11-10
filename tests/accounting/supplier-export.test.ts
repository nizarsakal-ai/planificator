// Export comptable des factures fournisseurs : contenu CSV, filtres du lien, garde de la route.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import { buildSupplierExportCsv, supplierExportHref, SUPPLIER_EXPORT_HEADER, type SupplierExportRow } from "@/lib/accounting/ui/supplier-export"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8")
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const row = (o: Partial<SupplierExportRow> = {}): SupplierExportRow => ({
  supplierName: "KOLT", siret: "83763320600013", number: "379093", date: d("2026-10-27"), dueDate: null,
  totalHTCents: BigInt(6609), vatCents: BigInt(661), totalTTCCents: BigInt(7270), vatRateBp: 1000, status: "PENDING", category: "deplacement",
  validatedAt: null, paidAt: null, expenseAccount: { number: "625000", label: "Déplacements, missions et réceptions" }, supplier: null, ...o,
})
const LABELS = { deplacement: "Déplacements" }

describe("export comptable des factures fournisseurs", () => {
  it("une ligne par facture, format CSV comptable (BOM, « ; », virgule décimale, CRLF)", () => {
    const csv = buildSupplierExportCsv([row()], LABELS)
    assert.ok(csv.startsWith("﻿"))
    const lines = csv.slice(1).split("\r\n")
    assert.equal(lines[0], SUPPLIER_EXPORT_HEADER.join(";"))
    assert.equal(lines[1], "27/10/2026;KOLT;83763320600013;379093;;66,09;6,61;72,70;10;625000;Déplacements, missions et réceptions;À valider;;")
    assert.equal(lines[2], "")
    assert.equal(lines.length, 3)
  })

  it("facture validée et payée : fournisseur rattaché, dates, taux décimal", () => {
    const csv = buildSupplierExportCsv([row({ supplier: { name: "Kolt SAS" }, status: "VALIDATED", vatRateBp: 550, dueDate: d("2026-11-30"), validatedAt: new Date("2026-10-28T23:30:00.000Z"), paidAt: d("2026-11-02") })], LABELS)
    assert.equal(csv.slice(1).split("\r\n")[1], "27/10/2026;Kolt SAS;83763320600013;379093;30/11/2026;66,09;6,61;72,70;5,5;625000;Déplacements, missions et réceptions;Validée;29/10/2026;02/11/2026")
  })

  it("sans compte de charge : libellé de catégorie ; valeurs absentes vides ; formules neutralisées", () => {
    const csv = buildSupplierExportCsv([row({ supplierName: "=cmd|x", siret: null, vatRateBp: null, expenseAccount: null })], LABELS)
    assert.equal(csv.slice(1).split("\r\n")[1], "27/10/2026;'=cmd|x;;379093;;66,09;6,61;72,70;;;Déplacements;À valider;;")
  })

  it("le lien reprend les filtres actifs de la liste", () => {
    assert.equal(supplierExportHref({ q: "", status: undefined }), "/comptabilite/fournisseurs/export")
    assert.equal(supplierExportHref({ q: "cali game", status: "VALIDATED" }), "/comptabilite/fournisseurs/export?q=cali+game&statut=VALIDATED")
  })

  it("la page expose le bouton ; la route est gardée et ne lit que la société de la session", () => {
    assert.match(read("src/app/(dashboard)/comptabilite/fournisseurs/page.tsx"), /<a href=\{supplierExportHref\(\{ q, status \}\)\}>Export comptable<\/a>/)
    const route = read("src/app/(dashboard)/comptabilite/fournisseurs/export/route.ts")
    assert.ok(route.indexOf("await requireAccountingRoute()") < route.indexOf("request.url"))
    assert.match(route, /listSupplierInvoicesForExport\(prisma, guard\.ctx,/)
  })
})
