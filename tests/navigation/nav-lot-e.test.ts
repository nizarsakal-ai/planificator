/**
 * Lot E Planificator V2 : navigation « Pipeline commercial » (CRM_OPPORTUNITIES_ENABLED, catégorie Commercial,
 * /crm/opportunites) et « Automatisations » (AUTOMATIONS_ENABLED, catégorie Administration).
 * - Deux drapeaux désactivés ⇒ navigation de main strictement inchangée (tous rôles × 512 combinaisons des drapeaux existants).
 * - Quatre combinaisons CRM × automatisations : chaque entrée n'apparaît qu'avec son drapeau, dans sa catégorie, sans doublon.
 * - L'entrée Prospection « /opportunites » n'est jamais modifiée, déplacée ni confondue avec la route CRM.
 * - Câblage identique dans Sidebar.tsx et MobileNav.tsx ; drapeaux lus côté serveur seulement (layout).
 * Données synthétiques uniquement, aucune base.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import type { Role } from "@prisma/client"
import {
  AUTOMATION_NAV_ITEM, CRM_NAV_ITEM, getActiveNavHref, getNavItems, withAccountingNavItem, withBillingNavItems, withCrmAutomationNavItems,
  withEquipmentNavItem, withHrDocumentNavItems, withProspectionNavItem, withStockPurchasingNavItems, withSupplierIntakeNavItem,
  withWorksitePhotosNavItem, type NavItem,
} from "@/lib/navigation/nav-config"
import { NAV_CATEGORY_DEFINITIONS, NAV_CATEGORY_EXTENSIONS, getActiveNavCategoryId, groupNavItems } from "@/lib/navigation/nav-categories"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")

type Flags = { accounting: boolean; billing: boolean; supplier: boolean; photos: boolean; equipment: boolean; hrOwn: boolean; hrManage: boolean; prospection: boolean; stock: boolean }
/** Composition de main 12debffa (Sidebar.tsx et MobileNav.tsx avant le lot E). */
function main(role: Role, f: Flags): NavItem[] {
  return withStockPurchasingNavItems(withProspectionNavItem(withHrDocumentNavItems(withEquipmentNavItem(withWorksitePhotosNavItem(withSupplierIntakeNavItem(withBillingNavItems(withAccountingNavItem(getNavItems(role), f.accounting), f.billing), f.supplier), f.photos), f.equipment), f.hrOwn, f.hrManage), f.prospection), f.stock)
}
/** Composition du lot E : même chaîne, entrées E insérées entre facturation et dépôt fournisseurs (ordre de Sidebar.tsx/MobileNav.tsx). */
function lotE(role: Role, f: Flags, crm: boolean, auto: boolean): NavItem[] {
  return withStockPurchasingNavItems(withProspectionNavItem(withHrDocumentNavItems(withEquipmentNavItem(withWorksitePhotosNavItem(withSupplierIntakeNavItem(withCrmAutomationNavItems(withBillingNavItems(withAccountingNavItem(getNavItems(role), f.accounting), f.billing), crm, auto), f.supplier), f.photos), f.equipment), f.hrOwn, f.hrManage), f.prospection), f.stock)
}
const ROLES: Role[] = ["SUPER_ADMIN", "ADMIN", "TEAM_LEADER", "EMPLOYEE", "CLIENT"]
const KEYS: (keyof Flags)[] = ["accounting", "billing", "supplier", "photos", "equipment", "hrOwn", "hrManage", "prospection", "stock"]
const FLAG_SETS: Flags[] = Array.from({ length: 1 << KEYS.length }, (_, n) => Object.fromEntries(KEYS.map((k, i) => [k, !!(n & (1 << i))])) as Flags)
const ALL_ON = FLAG_SETS[FLAG_SETS.length - 1]
const COMBOS = [[false, false], [true, false], [false, true], [true, true]] as const

describe("lot E : drapeaux désactivés ⇒ navigation de main inchangée", () => {
  for (const role of ROLES) {
    it(`${role} × ${FLAG_SETS.length} combinaisons : mêmes entrées, même ordre, mêmes catégories`, () => {
      for (const flags of FLAG_SETS) {
        const before = main(role, flags), after = lotE(role, flags, false, false)
        assert.deepEqual(after, before, `${role} ${JSON.stringify(flags)}`)
        assert.deepEqual(groupNavItems(after), groupNavItems(before))
      }
    })
  }
  it("seule la valeur booléenne true rend visible ; aucune mutation de l'entrée", () => {
    const base = main("ADMIN", ALL_ON), copy = [...base]
    assert.deepEqual(withCrmAutomationNavItems(base, "true" as unknown as boolean, 1 as unknown as boolean), base)
    assert.deepEqual(base, copy)
  })
})

describe("lot E : quatre combinaisons CRM × automatisations", () => {
  for (const [crm, auto] of COMBOS) {
    it(`CRM ${crm} × automatisations ${auto} : entrées, catégories, sans perte ni doublon, Prospection intacte`, () => {
      for (const role of ROLES) for (const flags of [ALL_ON, FLAG_SETS[0], { ...ALL_ON, prospection: false }]) {
        const composed = lotE(role, flags, crm, auto)
        const before = main(role, flags)
        assert.equal(composed.length, before.length + (crm ? 1 : 0) + (auto ? 1 : 0))
        assert.equal(composed.some((i) => i.href === "/crm/opportunites"), crm)
        assert.equal(composed.some((i) => i.href === "/automatisations"), auto)
        const grouped = groupNavItems(composed)
        const regrouped = [...grouped.categories.flatMap((c) => c.items), ...grouped.footer]
        assert.equal(regrouped.length, composed.length)
        assert.equal(new Set(regrouped.map((i) => i.href)).size, regrouped.length, "aucun doublon")
        assert.ok(grouped.categories.every((c) => c.id !== "autres"), `${role} ${JSON.stringify(flags)}`)
        if (crm) assert.ok(grouped.categories.find((c) => c.id === "commercial")!.items.some((i) => i.href === "/crm/opportunites" && i.label === "Pipeline commercial"))
        if (auto) assert.ok(grouped.categories.find((c) => c.id === "administration")!.items.some((i) => i.href === "/automatisations" && i.label === "Automatisations"))
        // Prospection : même entrée (libellé, href, icône) et même présence qu'avant le lot E.
        assert.deepEqual(composed.filter((i) => i.href === "/opportunites"), before.filter((i) => i.href === "/opportunites"))
        // Ordre relatif des entrées existantes conservé.
        assert.deepEqual(composed.filter((i) => i !== CRM_NAV_ITEM && i !== AUTOMATION_NAV_ITEM), before)
      }
    })
  }
  it("entrée active : /crm/opportunites/x ⇒ Pipeline commercial (Commercial) ; /opportunites ⇒ Prospection, jamais la route CRM", () => {
    const items = lotE("ADMIN", ALL_ON, true, true)
    for (const p of ["/crm/opportunites", "/crm/opportunites/op1"]) {
      assert.equal(getActiveNavHref(items, p), "/crm/opportunites")
      assert.equal(getActiveNavCategoryId(groupNavItems(items), "/crm/opportunites"), "commercial")
    }
    if (items.some((i) => i.href === "/opportunites")) assert.equal(getActiveNavHref(items, "/opportunites"), "/opportunites")
    assert.equal(getActiveNavHref(items, "/automatisations"), "/automatisations")
    assert.equal(getActiveNavCategoryId(groupNavItems(items), "/automatisations"), "administration")
  })
  it("idempotent : une seconde application n'ajoute rien", () => {
    const once = lotE("SUPER_ADMIN", ALL_ON, true, true)
    assert.deepEqual(withCrmAutomationNavItems(once, true, true), once)
  })
})

describe("lot E : câblage", () => {
  it("Sidebar.tsx et MobileNav.tsx composent dans le même ordre que ce test ; affichage seulement", () => {
    const chain = "withSupplierIntakeNavItem(withCrmAutomationNavItems(withBillingNavItems("
    for (const f of ["src/components/layout/Sidebar.tsx", "src/components/layout/MobileNav.tsx"]) {
      const src = read(f)
      assert.ok(src.includes(chain), f)
      assert.ok(src.includes("user.crmNavVisible === true, user.automationNavVisible === true"), f)
      assert.doesNotMatch(src, /CRM_OPPORTUNITIES_ENABLED|AUTOMATIONS_ENABLED/, `${f} : aucun drapeau lu côté client`)
    }
  })
  it("layout : drapeau, rôle ADMIN/SUPER_ADMIN et société ; Prospection et sa route inchangées", () => {
    const layout = read("src/app/(dashboard)/layout.tsx")
    assert.ok(layout.includes(`const crmNavVisible = isCrmEnabled() && (role === "ADMIN" || role === "SUPER_ADMIN") && !!companyId`))
    assert.ok(layout.includes(`const automationNavVisible = isAutomationsEnabled() && (role === "ADMIN" || role === "SUPER_ADMIN") && !!companyId`))
  })
  it("catégories : listes de main inchangées (Prospection), rattachement E par extension, ordre Opportunités → Pipeline commercial", () => {
    assert.deepEqual(NAV_CATEGORY_DEFINITIONS.find((c) => c.id === "commercial")?.hrefs, ["/clients", "/consultations", "/opportunites", "/articles"])
    assert.deepEqual(NAV_CATEGORY_DEFINITIONS.find((c) => c.id === "administration")?.hrefs, ["/super-admin/entreprises", "/parametres"])
    assert.deepEqual(NAV_CATEGORY_EXTENSIONS.map((e) => [e.href, e.id]), [["/crm/opportunites", "commercial"], ["/automatisations", "administration"]])
    const g = groupNavItems(lotE("SUPER_ADMIN", ALL_ON, true, true))
    const commercial = g.categories.find((c) => c.id === "commercial")!.items.map((i) => i.href)
    const at = commercial.indexOf("/crm/opportunites")
    if (commercial.includes("/opportunites")) assert.equal(commercial[at - 1], "/opportunites")
    const admin = g.categories.find((c) => c.id === "administration")!.items.map((i) => i.href)
    assert.equal(admin[admin.length - 1], "/automatisations")
  })
})
