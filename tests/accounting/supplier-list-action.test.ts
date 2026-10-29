// Liste des factures fournisseurs — action explicite par ligne (29/10/2026). Tests purs + contrôle de source de la page liste :
// la liste ouvre la fiche de vérification et n'exécute aucune validation directe.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { supplierRowAction } from "@/lib/accounting/ui/supplier-row-action"

const PAGE = "src/app/(dashboard)/comptabilite/fournisseurs/page.tsx"
const page = readFileSync(PAGE, "utf8")
const code = page.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")

describe("supplierRowAction — règle d'action par ligne", () => {
  const row = { id: "si_1", number: "F-2026-07", supplierName: "CALI GAME" }
  it("PENDING ⇒ « Vérifier / valider », action principale, vers la fiche, libellé accessible complet", () => {
    assert.deepEqual(supplierRowAction({ ...row, status: "PENDING" }), { label: "Vérifier / valider", href: "/comptabilite/fournisseurs/si_1", ariaLabel: "Vérifier puis valider la facture F-2026-07 — CALI GAME", variant: "default" })
  })
  it("VALIDATED et REJECTED ⇒ « Consulter », action secondaire, même fiche", () => {
    for (const status of ["VALIDATED", "REJECTED"]) {
      assert.deepEqual(supplierRowAction({ ...row, status }), { label: "Consulter", href: "/comptabilite/fournisseurs/si_1", ariaLabel: "Consulter la facture F-2026-07 — CALI GAME", variant: "outline" })
    }
  })
  it("statut inconnu ⇒ consultation (jamais une action de validation par défaut) ; identifiant encodé", () => {
    const a = supplierRowAction({ id: "a b/c", status: "WHATEVER", number: "N", supplierName: "S" })
    assert.equal(a.label, "Consulter"); assert.equal(a.href, "/comptabilite/fournisseurs/a%20b%2Fc")
  })
})

describe("page liste /comptabilite/fournisseurs — source", () => {
  it("le bouton est rendu dans la cellule Statut, juste à côté du badge (côte à côte dès sm, repliable et borné sur mobile), via supplierRowAction, avec aria-label ; pas de colonne séparée", () => {
    assert.match(code, /supplierRowAction\(\{ id: s\.id, status: s\.status/)
    assert.match(code, /<div className="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:whitespace-nowrap">\s*<span className=\{`rounded-full[^`]*`\}>\{STATUS\[s\.status\]\?\.label \?\? s\.status\}<\/span>\s*<Button asChild size="sm" variant=\{a\.variant\} className="[^"]*whitespace-normal[^"]*sm:whitespace-nowrap[^"]*"><Link href=\{a\.href\} aria-label=\{a\.ariaLabel\}>\{a\.label\}<\/Link><\/Button>/)
    assert.doesNotMatch(code, /<th[^>]*>Action<\/th>/)
    assert.equal((code.match(/<th /g) ?? []).length, 8, "nombre de colonnes inchangé")
  })
  it("aucune validation ni rejet depuis la liste : pas d'action serveur de validation, pas de SupplierValidateButtons, pas de formulaire d'action", () => {
    assert.doesNotMatch(code, /validateSupplierInvoiceAction|rejectSupplierInvoiceAction|SupplierValidateButtons|"use client"/)
    assert.doesNotMatch(code, /<form[^>]*action=/)
  })
  it("responsive : tableau défilable, cellule Statut (badge + bouton) jamais masquée, N° et date repliés sous le fournisseur sur petit écran", () => {
    assert.match(code, /<div className="overflow-x-auto">/)
    assert.match(code, /<th className="px-3 py-2">Statut<\/th>/)
    assert.match(code, /className="text-xs text-slate-500 sm:hidden">\{s\.number\} · \{dateFr\.format\(s\.date\)\}/)
    assert.match(code, /colSpan=\{8\}/)
  })
  it("la garde serveur et la requête de liste existantes sont inchangées", () => {
    assert.match(code, /await requireAccountingPage\(\)/)
    assert.match(code, /listSupplierInvoices\(prisma, ctx,/)
  })
})
