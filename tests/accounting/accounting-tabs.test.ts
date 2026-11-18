// Navigation simplifiée du module Comptabilité : cinq onglets, écrans experts regroupés sous « Plus », liste des achats par mois.
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import { ACCOUNTING_TABS, PLUS_HREF, PLUS_SECTIONS, activeAccountingTab } from "@/lib/accounting/ui/accounting-nav"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8")
const APP = "src/app/(dashboard)"

describe("onglets du module Comptabilité", () => {
  it("cinq onglets, dans l'ordre : Achats, Ventes, Devis, Banque, Plus", () => {
    assert.deepEqual(ACCOUNTING_TABS.map((t) => [t.label, t.href]), [
      ["Achats", "/comptabilite/fournisseurs"], ["Ventes", "/factures"], ["Devis", "/devis"], ["Banque", "/comptabilite/banque"], ["Plus", "/comptabilite/plus"],
    ])
  })

  it("onglet actif : la route de l'onglet, sinon « Plus » pour tout autre écran du module", () => {
    assert.equal(activeAccountingTab("/comptabilite/fournisseurs"), "/comptabilite/fournisseurs")
    assert.equal(activeAccountingTab("/comptabilite/fournisseurs/abc"), "/comptabilite/fournisseurs")
    assert.equal(activeAccountingTab("/comptabilite/banque"), "/comptabilite/banque")
    assert.equal(activeAccountingTab("/factures/123"), "/factures")
    assert.equal(activeAccountingTab("/devis"), "/devis")
    for (const p of ["/comptabilite", "/comptabilite/plus", "/comptabilite/ecritures/nouvelle", "/comptabilite/tva", "/comptabilite/fec"]) assert.equal(activeAccountingTab(p), PLUS_HREF, p)
    assert.equal(activeAccountingTab("/comptabilite-autre"), null)
    assert.equal(activeAccountingTab("/dashboard"), null)
  })

  it("aucun écran du module ne devient inaccessible : chaque page liste est un onglet ou un lien de « Plus »", () => {
    const reachable = new Set([...ACCOUNTING_TABS.map((t) => t.href), ...PLUS_SECTIONS.flatMap((s) => s.links.map((l) => l.href))])
    for (const screen of ["", "/balance", "/banque", "/ecritures", "/exercices", "/factures", "/fec", "/fournisseurs", "/grand-livre", "/plan", "/plus", "/tableau-de-bord", "/tva"]) {
      assert.ok(reachable.has(`/comptabilite${screen}`), `/comptabilite${screen}`)
    }
  })

  it("chaque lien pointe vers une page qui existe, sans doublon", () => {
    const hrefs = [...ACCOUNTING_TABS.map((t) => t.href), ...PLUS_SECTIONS.flatMap((s) => s.links.map((l) => l.href))]
    assert.equal(new Set(hrefs).size, hrefs.length)
    for (const href of hrefs) assert.ok(existsSync(join(ROOT, APP, href, "page.tsx")), href)
  })

  it("le composant de navigation ne définit aucune route lui-même", () => {
    const src = read("src/components/comptabilite/AccountingNav.tsx")
    assert.match(src, /ACCOUNTING_TABS\.map/)
    assert.doesNotMatch(src, /href: "/)
  })

  it("liste des achats : un intertitre par mois, sans changer le nombre de colonnes", () => {
    const src = read(`${APP}/comptabilite/fournisseurs/page.tsx`)
    assert.match(src, /monthKey\(list\.rows\[i - 1\]!\.date\) !== monthKey\(s\.date\)/)
    assert.match(src, /<td colSpan=\{8\}[^>]*>\{monthFr\.format\(s\.date\)\}<\/td>/)
  })
})
