// Liste des factures fournisseurs — actions explicites par ligne (29/10/2026). Tests purs + contrôle de source de la page liste :
// « Vérifier » ouvre la fiche ; « Valider » (PENDING seulement) passe par SupplierQuickValidateButton, qui appelle l'action serveur existante.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { supplierRowAction } from "@/lib/accounting/ui/supplier-row-action"

const PAGE = "src/app/(dashboard)/comptabilite/fournisseurs/page.tsx"
const page = readFileSync(PAGE, "utf8")
const code = page.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")

describe("supplierRowAction — règle d'action par ligne", () => {
  const row = { id: "si_1", number: "F-2026-07", supplierName: "CALI GAME" }
  it("PENDING ⇒ lien « Vérifier » vers la fiche + bouton « Valider » distinct, libellés accessibles complets", () => {
    assert.deepEqual(supplierRowAction({ ...row, status: "PENDING" }), { label: "Vérifier", href: "/comptabilite/fournisseurs/si_1", ariaLabel: "Vérifier la facture F-2026-07 — CALI GAME", variant: "outline", quickValidate: true, validateAriaLabel: "Valider la facture F-2026-07 — CALI GAME" })
  })
  it("VALIDATED et REJECTED ⇒ « Consulter », action secondaire, même fiche", () => {
    for (const status of ["VALIDATED", "REJECTED"]) {
      assert.deepEqual(supplierRowAction({ ...row, status }), { label: "Consulter", href: "/comptabilite/fournisseurs/si_1", ariaLabel: "Consulter la facture F-2026-07 — CALI GAME", variant: "outline", quickValidate: false, validateAriaLabel: null })
    }
  })
  it("statut inconnu ⇒ consultation (jamais une action de validation par défaut) ; identifiant encodé", () => {
    const a = supplierRowAction({ id: "a b/c", status: "WHATEVER", number: "N", supplierName: "S" })
    assert.equal(a.label, "Consulter"); assert.equal(a.quickValidate, false); assert.equal(a.href, "/comptabilite/fournisseurs/a%20b%2Fc")
  })
})

describe("page liste /comptabilite/fournisseurs — source", () => {
  it("le bouton est rendu dans la cellule Statut, juste à côté du badge (côte à côte dès sm, repliable et borné sur mobile), via supplierRowAction, avec aria-label ; pas de colonne séparée", () => {
    assert.match(code, /supplierRowAction\(\{ id: s\.id, status: s\.status/)
    assert.match(code, /const row = \(<>\s*<span className=\{`rounded-full[^`]*`\}>\{STATUS\[s\.status\]\?\.label \?\? s\.status\}<\/span>\s*<Button asChild size="sm" variant=\{a\.variant\} className="[^"]*whitespace-normal[^"]*sm:whitespace-nowrap[^"]*"><Link href=\{a\.href\} aria-label=\{a\.ariaLabel\}>\{a\.label\}<\/Link><\/Button>\s*<\/>\)/)
    assert.match(code, /: <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:whitespace-nowrap">\{row\}<\/div>/, "autres statuts : badge + « Consulter » côte à côte")
    assert.match(code, /a\.quickValidate && a\.validateAriaLabel\s*\? <SupplierQuickValidateButton id=\{s\.id\} expenseAccountId=\{s\.expenseAccountId\} ariaLabel=\{a\.validateAriaLabel\} verifyHref=\{a\.href\}>\{row\}<\/SupplierQuickValidateButton>/, "« Valider » dans la même cellule, juste après badge + « Vérifier »")
    assert.doesNotMatch(code, /<th[^>]*>Action<\/th>/)
    assert.equal((code.match(/<th /g) ?? []).length, 8, "nombre de colonnes inchangé")
  })
  it("la page reste un composant serveur : la validation ne passe que par SupplierQuickValidateButton ; pas de rejet ni de formulaire d'action dans la liste", () => {
    assert.doesNotMatch(code, /validateSupplierInvoiceAction|rejectSupplierInvoiceAction|SupplierValidateButtons|"use client"/)
    assert.doesNotMatch(code, /<form[^>]*action=/)
  })
  it("le bouton « Valider » appelle l'action serveur EXISTANTE avec le compte déjà enregistré (jamais un compte choisi côté client), sans navigation ni confirmation", () => {
    const btn = readFileSync("src/components/comptabilite/SupplierQuickValidateButton.tsx", "utf8")
    assert.match(btn, /^"use client"/)
    assert.match(btn, /validate: \(\) => validateSupplierInvoiceAction\(id, expenseAccountId \?\? undefined\)/)
    assert.doesNotMatch(btn, /router\.push|router\.replace|window\.location|redirect\(|window\.confirm|window\.prompt|confirm\(/)
    assert.match(btn, /const locked = busy \|\| done \|\| refreshing/, "désactivé pendant l'appel, puis après succès jusqu'au rafraîchissement et au remplacement de la ligne")
    assert.match(btn, /disabled=\{locked\} aria-busy=\{locked\}/)
    assert.match(btn, /refresh: \(\) => startRefresh\(\(\) => router\.refresh\(\)\)/)
    // L'erreur est un bloc borné SOUS la rangée (hors du conteneur flex-nowrap), avec accès « Vérifier ».
    assert.match(btn, /<div className="flex flex-col gap-1">\s*<div className="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:whitespace-nowrap">[\s\S]*?<\/div>\s*\{error && <p role="alert" className="max-w-\[16rem\] whitespace-normal[^"]*">\{error\} <Link href=\{verifyHref\}/)
  })
  it("la requête de liste expose expenseAccountId en lecture seule (aucune autre modification du service)", () => {
    const svc = readFileSync("src/lib/accounting/c5/supplier-invoice.service.ts", "utf8")
    assert.match(svc, /fileId: true, expenseAccountId: true, expenseAccount: \{ select: \{ number: true, label: true \} \}/)
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
