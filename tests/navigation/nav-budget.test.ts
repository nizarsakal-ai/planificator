/**
 * Lot C Planificator V2 (budgets et marges chantier), intégré sur l'arbre publié 35c0f227 — entrée « Budgets » dans la
 * navigation de PRODUCTION (V1, regroupement par catégories).
 * Drapeau C désactivé ⇒ navigation strictement identique à la composition publiée A + B (tous rôles × drapeaux existants).
 * Drapeau activé ⇒ une entrée dans « Finance », après les entrées Finance existantes, jamais dans « Autres ».
 * Plus : câblage Sidebar/MobileNav/layout sans lecture de drapeau côté client, drapeau désactivé par défaut, migration du
 * lot C renumérotée APRÈS la production (A < B < garde < C), contenu épinglé. Données synthétiques uniquement.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import ts from "typescript"
import type { Role } from "@prisma/client"
import {
  getActiveNavHref, getNavItems, withAccountingNavItem, withBillingNavItems, withBudgetNavItem, withEquipmentNavItem,
  withHrDocumentNavItems, withProspectionNavItem, withStockPurchasingNavItems, withSupplierIntakeNavItem, withWorksitePhotosNavItem,
  type NavItem,
} from "@/lib/navigation/nav-config"
import { getActiveNavCategoryId, groupNavItems } from "@/lib/navigation/nav-categories"
import { isWorksiteBudgetEnabled } from "@/lib/budget/budget-feature-flag"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")

type Flags = { accounting: boolean; billing: boolean; supplier: boolean; photos: boolean; hrOwn: boolean; hrManage: boolean; prospection: boolean; stock: boolean; equipment: boolean }
/** Composition publiée 35c0f227 (A + B), à l'identique de Sidebar.tsx et MobileNav.tsx de cet arbre. */
function published(role: Role, f: Flags): NavItem[] {
  return withStockPurchasingNavItems(withProspectionNavItem(withHrDocumentNavItems(withEquipmentNavItem(withWorksitePhotosNavItem(withSupplierIntakeNavItem(withBillingNavItems(withAccountingNavItem(getNavItems(role), f.accounting), f.billing), f.supplier), f.photos), f.equipment), f.hrOwn, f.hrManage), f.prospection), f.stock)
}
/** Composition lot C : même chaîne, « Budgets » inséré entre facturation et dépôt fournisseurs (même ordre que Sidebar.tsx/MobileNav.tsx). */
function lotC(role: Role, f: Flags, budget: boolean): NavItem[] {
  return withStockPurchasingNavItems(withProspectionNavItem(withHrDocumentNavItems(withEquipmentNavItem(withWorksitePhotosNavItem(withSupplierIntakeNavItem(withBudgetNavItem(withBillingNavItems(withAccountingNavItem(getNavItems(role), f.accounting), f.billing), budget), f.supplier), f.photos), f.equipment), f.hrOwn, f.hrManage), f.prospection), f.stock)
}
const ROLES: Role[] = ["SUPER_ADMIN", "ADMIN", "TEAM_LEADER", "EMPLOYEE", "CLIENT"]
const FLAG_SETS: Flags[] = Array.from({ length: 512 }, (_, n) => ({
  accounting: !!(n & 1), billing: !!(n & 2), supplier: !!(n & 4), photos: !!(n & 8), hrOwn: !!(n & 16), hrManage: !!(n & 32),
  prospection: !!(n & 64), stock: !!(n & 128), equipment: !!(n & 256),
}))
const ALL_ON = FLAG_SETS[511]
const finance = (items: NavItem[]) => groupNavItems(items).categories.find((c) => c.id === "finance")?.items.map((i) => i.href) ?? []

describe("Lot C : drapeau désactivé ⇒ navigation publiée inchangée", () => {
  for (const role of ROLES) {
    it(`${role} × 512 combinaisons : mêmes entrées, même ordre, mêmes catégories`, () => {
      for (const flags of FLAG_SETS) {
        const before = published(role, flags)
        const after = lotC(role, flags, false)
        assert.deepEqual(after, before, `${role} ${JSON.stringify(flags)}`)
        assert.deepEqual(groupNavItems(after), groupNavItems(before))
        assert.equal(after.some((i) => i.href === "/budgets"), false)
      }
    })
  }
  it("seule la valeur booléenne true rend visible ; nouvelle instance sans mutation", () => {
    const base = published("ADMIN", ALL_ON)
    const copy = [...base]
    assert.deepEqual(withBudgetNavItem(base, "true" as unknown as boolean), base)
    assert.notEqual(withBudgetNavItem(base, false), base)
    assert.deepEqual(base, copy)
  })
})

describe("Lot C : drapeau activé ⇒ « Budgets » dans « Finance »", () => {
  for (const role of ROLES) {
    it(`${role} × 512 combinaisons : partition sans perte ni doublon, jamais « Autres », Finance existante conservée puis Budgets`, () => {
      for (const flags of FLAG_SETS) {
        const composed = lotC(role, flags, true)
        const grouped = groupNavItems(composed)
        const regrouped = [...grouped.categories.flatMap((c) => c.items), ...grouped.footer]
        assert.equal(regrouped.length, composed.length)
        assert.deepEqual(new Set(regrouped), new Set(composed))
        assert.equal(new Set(regrouped.map((i) => i.href)).size, regrouped.length, "aucun doublon")
        assert.ok(grouped.categories.every((c) => c.id !== "autres"), `${role} ${JSON.stringify(flags)}`)
        assert.equal(composed.length, published(role, flags).length + 1)
        assert.deepEqual(finance(composed), [...finance(published(role, flags)), "/budgets"], `${role} ${JSON.stringify(flags)}`)
        // Les autres catégories (RH, terrain A/B, commercial…) sont identiques.
        const autres = (items: NavItem[]) => groupNavItems(items).categories.filter((c) => c.id !== "finance")
        assert.deepEqual(autres(composed), autres(published(role, flags)))
      }
    })
  }
  it("idempotent ; libellé et icône définis ; entrée active imbriquée /budgets/w1 ⇒ /budgets, catégorie « finance »", () => {
    const once = lotC("ADMIN", ALL_ON, true)
    assert.deepEqual(withBudgetNavItem(once, true), once)
    const entry = once.find((i) => i.href === "/budgets")
    assert.equal(entry?.label, "Budgets")
    assert.ok(entry?.icon)
    for (const pathname of ["/budgets", "/budgets/w1", "/budgets/export"]) {
      const active = getActiveNavHref(once, pathname)
      assert.equal(active, "/budgets")
      assert.equal(getActiveNavCategoryId(groupNavItems(once), active), "finance")
    }
  })
})

/** Occurrences de `name` dans le CODE (arbre syntaxique TypeScript/TSX) : commentaires exclus. Même contrôle que les lots A et B. */
const codeOccurrences = (src: string, name: string): string[] => {
  const sf = ts.createSourceFile("controle.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: string[] = []
  const visit = (n: ts.Node): void => {
    if ((ts.isIdentifier(n) || ts.isStringLiteralLike(n) || ts.isJsxText(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) && n.text.includes(name)) found.push(n.getText(sf))
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return found
}

describe("Lot C : câblage serveur et drapeau désactivé par défaut", () => {
  it("le drapeau n'est actif que pour la valeur exacte « true », indépendamment des lots A et B", () => {
    assert.equal(isWorksiteBudgetEnabled({}), false)
    for (const v of ["1", "TRUE", "yes", " true", ""]) assert.equal(isWorksiteBudgetEnabled({ WORKSITE_BUDGET_ENABLED: v }), false, v)
    assert.equal(isWorksiteBudgetEnabled({ STOCK_PURCHASING_ENABLED: "true", EQUIPMENT_RENTAL_ENABLED: "true" }), false)
    assert.equal(isWorksiteBudgetEnabled({ WORKSITE_BUDGET_ENABLED: "true" }), true)
  })
  it("Sidebar et MobileNav insèrent le helper dans le menu composé, avec la visibilité serveur ; aucune lecture de drapeau", () => {
    for (const file of ["src/components/layout/Sidebar.tsx", "src/components/layout/MobileNav.tsx"]) {
      const src = read(file)
      assert.match(src, /const navItems = withBudgetNavItem\(.+, user\.budgetNavVisible === true\)/, file)
      assert.equal(src.match(/withBudgetNavItem\(/g)?.length, 1, `${file} : une seule insertion`)
      assert.doesNotMatch(src, /process\.env/, `${file} ne lit aucune variable d'environnement`)
      assert.deepEqual(codeOccurrences(src, "WORKSITE_BUDGET_ENABLED"), [], `${file} ne lit aucun drapeau`)
      assert.doesNotMatch(src, /isWorksiteBudgetEnabled|budget-feature-flag/, `${file} n'importe pas le helper serveur du drapeau`)
    }
    const layout = read("src/app/(dashboard)/layout.tsx")
    assert.match(layout, /const budgetNavVisible = isWorksiteBudgetEnabled\(\) && \(role === "ADMIN" \|\| role === "SUPER_ADMIN"\) && !!companyId/)
    assert.match(layout, /const user = \{[^\n]*\bbudgetNavVisible\b[^\n]*\}/)
    assert.doesNotMatch(read("src/components/layout/Navbar.tsx"), /budget/i, "Navbar inchangé : il transmet user à MobileNav")
  })
})

describe("Lot C : migration renumérotée après la production, contenu épinglé", () => {
  const C = "20261111120000_v2_lot_c_worksite_budgets"
  const PREVIOUS = ["20261110120000_v2_lot_a_stock_purchasing", "20261110130000_v2_lot_b_equipment_rental", "20261110140000_v2_lot_b_booking_overlap_guard"]
  const dirs = readdirSync(join(ROOT, "prisma/migrations"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  it("présente une fois, ancien nom absent, horodatage unique et postérieur aux lots A, B et à la garde", () => {
    assert.equal(dirs.filter((d) => d === C).length, 1)
    assert.equal(dirs.some((d) => d.startsWith("20261104140000_v2_lot_c")), false, "ancien horodatage absent")
    assert.equal(dirs.filter((d) => d.startsWith(`${C.slice(0, 14)}_`)).length, 1, "horodatage unique")
    for (const d of PREVIOUS) {
      assert.ok(dirs.includes(d) && d.slice(0, 14) < C.slice(0, 14), `${d} doit précéder le lot C`)
    }
  })
  it("contenu épinglé : migration qualifiée du lot C + garde d'ajout de ligne (revue v1 P1) + version courante enregistrée (C-R1), sha256 explicite", () => {
    const sha = createHash("sha256").update(readFileSync(join(ROOT, `prisma/migrations/${C}/migration.sql`))).digest("hex")
    assert.equal(sha, "abc86998b82d7671cfc04e79eca6c067d8da468dcf39b773f3179c212d2d6c16")
  })
})
