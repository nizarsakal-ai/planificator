/**
 * Lot D Planificator V2 (réserves, indicateurs commerciaux, recherche), réconcilié sur l'arbre publié b0a2523e (C publié).
 * Test PROPRE À D : exécuté sur la candidate seulement (il n'existe pas dans la base).
 * - Drapeaux D désactivés ⇒ navigation STRICTEMENT identique à la composition publiée (A + B + C), pour tous les rôles et
 *   les 1 024 combinaisons des drapeaux existants (dont celui de C).
 * - Drapeau activé ⇒ « Réserves » dans « Chantiers & terrain » et « Indicateurs commerciaux » dans « Commercial », en fin
 *   de catégorie, jamais dans « Autres » ; aucune autre entrée déplacée ; « Budgets » (C) inchangé.
 * - Câblage : Sidebar et MobileNav gardent la composition publiée telle quelle (fonction navItemsPublies) et n'ajoutent D
 *   qu'après ; `navItems` du composant est la composition complète (témoin nav-config : élément actif) ; aucune lecture
 *   de drapeau côté client ; Navbar n'affiche la recherche que sur visibilité serveur ; /dashboard non modifié.
 * Données synthétiques uniquement.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import type { Role } from "@prisma/client"
import {
  getNavItems, withAccountingNavItem, withBillingNavItems, withBudgetNavItem, withEquipmentNavItem, withHrDocumentNavItems,
  withProspectionNavItem, withReservesNavItem, withSalesDashboardNavItem, withStockPurchasingNavItems, withSupplierIntakeNavItem,
  withWorksitePhotosNavItem, type NavItem,
} from "@/lib/navigation/nav-config"
import { groupNavItems, navCategoryOf } from "@/lib/navigation/nav-categories"
import { isWorksiteReservesEnabled } from "@/lib/reserves/reserves-feature-flag"
import { isSalesDashboardEnabled } from "@/lib/sales-dashboard/sales-feature-flag"
import { isGlobalSearchEnabled } from "@/lib/search/search-feature-flag"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")

type Flags = { accounting: boolean; billing: boolean; supplier: boolean; photos: boolean; hrOwn: boolean; hrManage: boolean; prospection: boolean; stock: boolean; equipment: boolean; budget: boolean }
/** Composition publiée b0a2523e (A + B + C), à l'identique de la ligne `const navItems = …` de Sidebar.tsx et MobileNav.tsx. */
function published(role: Role, f: Flags): NavItem[] {
  return withStockPurchasingNavItems(withProspectionNavItem(withHrDocumentNavItems(withEquipmentNavItem(withWorksitePhotosNavItem(withSupplierIntakeNavItem(withBudgetNavItem(withBillingNavItems(withAccountingNavItem(getNavItems(role), f.accounting), f.billing), f.budget), f.supplier), f.photos), f.equipment), f.hrOwn, f.hrManage), f.prospection), f.stock)
}
/** Composition D : la publiée, puis les deux entrées D (même ordre que `const menuItems = …`). */
function lotD(role: Role, f: Flags, reserves: boolean, sales: boolean): NavItem[] {
  return withSalesDashboardNavItem(withReservesNavItem(published(role, f), reserves), sales)
}
const ROLES: Role[] = ["SUPER_ADMIN", "ADMIN", "TEAM_LEADER", "EMPLOYEE", "CLIENT"]
const FLAG_SETS: Flags[] = Array.from({ length: 1024 }, (_, n) => ({
  accounting: !!(n & 1), billing: !!(n & 2), supplier: !!(n & 4), photos: !!(n & 8), hrOwn: !!(n & 16), hrManage: !!(n & 32),
  prospection: !!(n & 64), stock: !!(n & 128), equipment: !!(n & 256), budget: !!(n & 512),
}))
const shape = (items: NavItem[]) => {
  const g = groupNavItems(items)
  return { categories: g.categories.map((c) => ({ id: c.id, items: c.items.map((i) => `${i.label}|${i.href}`) })), footer: g.footer.map((i) => `${i.label}|${i.href}`) }
}

describe("Lot D : navigation", () => {
  it("drapeaux D désactivés ⇒ identique à la composition publiée (5 rôles × 1 024 combinaisons)", () => {
    for (const role of ROLES) for (const f of FLAG_SETS) {
      assert.deepEqual(lotD(role, f, false, false), published(role, f), `${role} ${JSON.stringify(f)}`)
    }
  })
  it("drapeaux D activés ⇒ deux entrées, dans leurs catégories, en fin de catégorie ; rien d'autre ne bouge", () => {
    for (const role of ROLES) for (const f of FLAG_SETS.filter((_, n) => n % 37 === 0 || n === 1023)) {
      const before = shape(published(role, f))
      const after = shape(lotD(role, f, true, true))
      const terrain = after.categories.find((c) => c.id === "terrain")!
      const commercial = after.categories.find((c) => c.id === "commercial")!
      assert.equal(terrain.items.at(-1), "Réserves|/reserves", `${role} terrain`)
      assert.equal(commercial.items.at(-1), "Indicateurs commerciaux|/tableaux-de-bord", `${role} commercial`)
      assert.equal(after.categories.some((c) => c.id === "autres"), before.categories.some((c) => c.id === "autres"), "jamais dans « Autres »")
      const strip = (s: ReturnType<typeof shape>) => ({ ...s, categories: s.categories.map((c) => ({ ...c, items: c.items.filter((i) => !i.endsWith("|/reserves") && !i.endsWith("|/tableaux-de-bord")) })).filter((c) => c.items.length > 0) })
      assert.deepEqual(strip(after), before, `${role} : autres entrées inchangées`)
    }
  })
  it("catégories : /reserves → terrain, /tableaux-de-bord → commercial ; /dashboard et /budgets inchangés", () => {
    assert.equal(navCategoryOf("/reserves"), "terrain")
    assert.equal(navCategoryOf("/tableaux-de-bord"), "commercial")
    assert.equal(navCategoryOf("/dashboard"), "pilotage")
    assert.equal(navCategoryOf("/budgets"), "finance")
  })
  it("aides idempotentes ; sans visibilité, aucune entrée", () => {
    const base = getNavItems("ADMIN")
    assert.deepEqual(withReservesNavItem(withReservesNavItem(base, true), true).filter((i) => i.href === "/reserves").length, 1)
    assert.deepEqual(withSalesDashboardNavItem(base, false), [...base])
    assert.deepEqual(withReservesNavItem(base, false), [...base])
  })
})

describe("Lot D : câblage serveur, drapeaux désactivés par défaut", () => {
  it("drapeaux : valeur exacte « true » seulement, indépendants des autres modules", () => {
    for (const v of [undefined, "", "1", "TRUE", " true"]) {
      assert.equal(isWorksiteReservesEnabled({ WORKSITE_RESERVES_ENABLED: v }), false)
      assert.equal(isSalesDashboardEnabled({ SALES_DASHBOARD_ENABLED: v }), false)
      assert.equal(isGlobalSearchEnabled({ GLOBAL_SEARCH_ENABLED: v }), false)
    }
    const others = { STOCK_PURCHASING_ENABLED: "true", EQUIPMENT_RENTAL_ENABLED: "true", WORKSITE_BUDGET_ENABLED: "true", BILLING_COMPLETE_ENABLED: "true" }
    assert.deepEqual([isWorksiteReservesEnabled(others), isSalesDashboardEnabled(others), isGlobalSearchEnabled(others)], [false, false, false])
  })
  it("Sidebar et MobileNav : composition publiée intacte (isolée), entrées D ajoutées ensuite, navItems complet, aucune lecture de drapeau", () => {
    for (const file of ["src/components/layout/Sidebar.tsx", "src/components/layout/MobileNav.tsx"]) {
      const src = read(file)
      // Intégration sur main 743c5ec (23/11) : la composition de main (navItems, lots A à I, verrouillée par les tests de main) reste telle quelle ;
      // les seules entrées D sont ajoutées ENSUITE (menuItems), qui alimente l'élément actif et les catégories.
      assert.doesNotMatch(src, /navItemsPublies/, `${file} : plus de composition historique dupliquée`)
      assert.match(src, /const menuItems = withSalesDashboardNavItem\(withReservesNavItem\(navItems, user\.reservesNavVisible === true\), user\.salesDashboardNavVisible === true\)\n  const activeHref = getActiveNavHref\(menuItems, pathname\)/, file)
      assert.match(src, /groupNavItems\(menuItems\)/, file)
      for (const h of ["withReservesNavItem(", "withSalesDashboardNavItem("]) assert.equal(src.split(h).length - 1, 1, `${file} : ${h} une fois`)
      assert.ok(src.indexOf("const navItems = ") >= 0 && src.indexOf("const navItems = ") < src.indexOf("const menuItems = "), `${file} : entrées D ajoutées APRÈS la composition de main, inchangée`)
      assert.doesNotMatch(src, /process\.env|WORKSITE_RESERVES_ENABLED|SALES_DASHBOARD_ENABLED|GLOBAL_SEARCH_ENABLED|feature-flag/, file)
    }
  })
  it("layout : visibilités serveur D (drapeau + ADMIN/SUPER_ADMIN + société), invariants C et B conservés", () => {
    const layout = read("src/app/(dashboard)/layout.tsx")
    for (const [v, fn] of [["reservesNavVisible", "isWorksiteReservesEnabled"], ["salesDashboardNavVisible", "isSalesDashboardEnabled"], ["searchVisible", "isGlobalSearchEnabled"]]) {
      assert.match(layout, new RegExp(`const ${v} = ${fn}\\(\\) && \\(role === "ADMIN" \\|\\| role === "SUPER_ADMIN"\\) && !!companyId`), v)
    }
    assert.match(layout, /const user = \{[^\n]*\bbudgetNavVisible\b[^\n]*\}/, "invariant C (objet user de main, ordre libre)")
    assert.match(layout, /const user = \{[^\n]*\bstockPurchasingNavVisible, equipmentNavVisible\b[^\n]*\}/, "invariant B")
    const userLigne = layout.slice(layout.indexOf("const user = {"), layout.indexOf("\n", layout.indexOf("const user = {")))
    for (const v of ["reservesNavVisible", "salesDashboardNavVisible", "searchVisible"]) assert.equal((userLigne.match(new RegExp(`\\b${v}\\b`, "g")) ?? []).length, 1, `${v} transmis une fois`)
  })
  it("Navbar : recherche seulement sur visibilité serveur ; aucune mention « budget » ; /dashboard non touché par D", () => {
    const nav = read("src/components/layout/Navbar.tsx")
    assert.match(nav, /\{user\.searchVisible === true && <SearchPalette \/>\}/)
    assert.doesNotMatch(nav, /budget/i)
    assert.doesNotMatch(nav, /process\.env/)
    assert.doesNotMatch(read("src/app/(dashboard)/dashboard/page.tsx"), /sales-dashboard|reserves|SearchPalette/, "tableau de bord existant inchangé")
  })
})
