/**
 * Lot I Planificator V2 : navigation « Marketing » et « Boutique » (un seul drapeau MARKETING_SHOP_ENABLED, catégorie
 * Commercial).
 * - Drapeau désactivé ⇒ navigation de main + E strictement inchangée (tous rôles × combinaisons des drapeaux existants).
 * - Drapeau activé ⇒ exactement deux entrées, dans Commercial, après « Articles » quand il est présent ; toute entrée
 *   existante garde sa catégorie ; la catégorie de repli « autres » est identique avec et sans I.
 * - Extension DISTINCTE ; câblage identique dans Sidebar.tsx et MobileNav.tsx (helper I le plus extérieur) ; drapeau lu
 *   côté serveur (layout). Données synthétiques uniquement, aucune base.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import type { Role } from "@prisma/client"
import {
  MARKETING_NAV_ITEM, SHOP_NAV_ITEM, getActiveNavHref, getNavItems, withAccountingNavItem, withBillingNavItems, withCrmAutomationNavItems, withEquipmentNavItem,
  withFuelTicketNavItem, withHrDocumentNavItems, withMarketingShopNavItems, withProspectionNavItem, withStockPurchasingNavItems, withSupplierIntakeNavItem,
  withWorksitePhotosNavItem, type NavItem,
} from "@/lib/navigation/nav-config"
import { NAV_CATEGORY_DEFINITIONS, NAV_CATEGORY_EXTENSIONS, NAV_CATEGORY_EXTENSIONS_LOT_I, getActiveNavCategoryId, groupNavItems } from "@/lib/navigation/nav-categories"

const read = (p: string) => readFileSync(p, "utf8")
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")

type Flags = { accounting: boolean; billing: boolean; supplier: boolean; photos: boolean; equipment: boolean; hrOwn: boolean; hrManage: boolean; prospection: boolean; stock: boolean; fuel: boolean; crm: boolean; auto: boolean }
/** Composition de Sidebar.tsx / MobileNav.tsx sur 90ae644 (main + lot E), sans le lot I. */
function avantI(role: Role, f: Flags): NavItem[] {
  return withFuelTicketNavItem(withStockPurchasingNavItems(withProspectionNavItem(withHrDocumentNavItems(withEquipmentNavItem(withWorksitePhotosNavItem(withSupplierIntakeNavItem(withCrmAutomationNavItems(withBillingNavItems(withAccountingNavItem(getNavItems(role), f.accounting), f.billing), f.crm, f.auto), f.supplier), f.photos), f.equipment), f.hrOwn, f.hrManage), f.prospection), f.stock), f.fuel)
}
const avecI = (role: Role, f: Flags, on: boolean) => withMarketingShopNavItems(avantI(role, f), on)
const ROLES: Role[] = ["SUPER_ADMIN", "ADMIN", "TEAM_LEADER", "EMPLOYEE", "CLIENT"]
const KEYS: (keyof Flags)[] = ["accounting", "billing", "supplier", "photos", "equipment", "hrOwn", "hrManage", "prospection", "stock", "fuel", "crm", "auto"]
const FLAG_SETS: Flags[] = Array.from({ length: 1 << KEYS.length }, (_, n) => Object.fromEntries(KEYS.map((k, i) => [k, !!(n & (1 << i))])) as Flags)
const ALL_ON = FLAG_SETS[FLAG_SETS.length - 1]

describe("lot I : drapeau désactivé ⇒ navigation inchangée", () => {
  for (const role of ROLES) {
    it(`${role} × ${FLAG_SETS.length} combinaisons : mêmes entrées, même ordre, mêmes catégories`, () => {
      for (const flags of FLAG_SETS) {
        const before = avantI(role, flags), after = avecI(role, flags, false)
        assert.deepEqual(after, before, `${role} ${JSON.stringify(flags)}`)
        assert.deepEqual(groupNavItems(after), groupNavItems(before))
      }
    })
  }
  it("seule la valeur booléenne true rend visible ; aucune mutation de l'entrée", () => {
    const base = avantI("ADMIN", ALL_ON), copy = [...base]
    for (const v of ["true", 1, "oui", null, undefined]) assert.deepEqual(withMarketingShopNavItems(base, v as unknown as boolean), base, String(v))
    assert.deepEqual(base, copy)
  })
})

describe("lot I : drapeau activé", () => {
  it("deux entrées dans Commercial ; entrées existantes dans leur catégorie ; « autres » identique ; sans doublon", () => {
    for (const role of ROLES) for (const flags of FLAG_SETS) {
      const ctx = `${role} ${JSON.stringify(flags)}`
      const before = avantI(role, flags), composed = avecI(role, flags, true)
      assert.equal(composed.length, before.length + 2)
      assert.deepEqual(composed.filter((i) => i !== MARKETING_NAV_ITEM && i !== SHOP_NAV_ITEM), before, `${ctx} : ordre relatif conservé`)
      const grouped = groupNavItems(composed), groupedBefore = groupNavItems(before)
      const regrouped = [...grouped.categories.flatMap((c) => c.items), ...grouped.footer]
      assert.equal(regrouped.length, composed.length)
      assert.equal(new Set(regrouped.map((i) => i.href)).size, regrouped.length, `${ctx} : aucun doublon`)
      assert.deepEqual(grouped.categories.find((c) => c.id === "autres"), groupedBefore.categories.find((c) => c.id === "autres"), `${ctx} : « autres » inchangée`)
      const categorieDe = (g: typeof grouped) => new Map(g.categories.flatMap((c) => c.items.map((i) => [i.href, c.id] as const)))
      const avant = categorieDe(groupedBefore), apres = categorieDe(grouped)
      for (const [href, id] of avant) assert.equal(apres.get(href), id, `${ctx} : ${href} garde sa catégorie`)
      assert.deepEqual([...apres.keys()].filter((h) => !avant.has(h)).sort(), ["/boutique", "/marketing"], `${ctx} : seules entrées ajoutées`)
      assert.equal(apres.get("/marketing"), "commercial")
      assert.equal(apres.get("/boutique"), "commercial")
      assert.deepEqual(grouped.footer, groupedBefore.footer)
      const commercial = grouped.categories.find((c) => c.id === "commercial")!.items.map((i) => i.href)
      assert.equal(commercial[commercial.indexOf("/marketing") + 1], "/boutique", `${ctx} : Boutique juste après Marketing`)
      if (commercial.includes("/articles")) assert.equal(commercial[commercial.indexOf("/marketing") - 1], "/articles", `${ctx} : après Articles`)
      assert.deepEqual(groupedBefore.categories.filter((c) => c.id !== "commercial"), grouped.categories.filter((c) => c.id !== "commercial"), `${ctx} : autres catégories inchangées`)
    }
  })
  it("entrées exactes, navigation native ; idempotent ; avant « Profil »", () => {
    assert.deepEqual({ ...MARKETING_NAV_ITEM, icon: undefined }, { label: "Marketing", href: "/marketing", icon: undefined, documentNavigation: true })
    assert.deepEqual({ ...SHOP_NAV_ITEM, icon: undefined }, { label: "Boutique", href: "/boutique", icon: undefined, documentNavigation: true })
    const once = avecI("SUPER_ADMIN", ALL_ON, true)
    assert.deepEqual(withMarketingShopNavItems(once, true), once)
    const base = getNavItems("ADMIN"), on = withMarketingShopNavItems(base, true)
    assert.equal(on.indexOf(SHOP_NAV_ITEM), on.findIndex((i) => i.href === "/profil") - 1)
  })
  it("entrée active : Marketing, Boutique et fiche d'une commande ⇒ Commercial", () => {
    const items = avecI("ADMIN", ALL_ON, true)
    assert.equal(getActiveNavHref(items, "/marketing"), "/marketing")
    for (const p of ["/boutique", "/boutique/commandes/o1"]) assert.equal(getActiveNavHref(items, p), "/boutique", p)
    assert.equal(getActiveNavCategoryId(groupNavItems(items), "/boutique"), "commercial")
  })
})

describe("lot I : catégories et câblage", () => {
  it("listes de main et extension E inchangées ; extension I distincte et exacte", () => {
    assert.deepEqual(NAV_CATEGORY_DEFINITIONS.find((c) => c.id === "commercial")?.hrefs, ["/clients", "/consultations", "/opportunites", "/articles"])
    assert.deepEqual(NAV_CATEGORY_EXTENSIONS.map((e) => [e.href, e.id]), [["/crm/opportunites", "commercial"], ["/automatisations", "administration"]])
    assert.deepEqual(NAV_CATEGORY_EXTENSIONS_LOT_I.map((e) => [e.href, e.id, e.rank]), [["/marketing", "commercial", 3.5], ["/boutique", "commercial", 3.6]])
  })
  it("Sidebar.tsx et MobileNav.tsx : helper I le plus extérieur de la chaîne intégrée FGHI, visibilité serveur ; aucun drapeau lu côté client", () => {
    // Intégration FGHI : I reste le plus extérieur ; F, G et H s'intercalent entre I et la base (chaîne exacte).
    for (const f of ["src/components/layout/Sidebar.tsx", "src/components/layout/MobileNav.tsx"]) {
      const src = read(f)
      assert.ok(src.includes("const navItems = withMarketingShopNavItems(withPayrollPrepNavItem(withDocumentStudioNavItem(withAssistantConnectorNavItems(withFuelTicketNavItem(withStockPurchasingNavItems("), f)
      assert.ok(src.includes("user.stockPurchasingNavVisible === true), user.fuelTicketNavVisible === true), user.assistantNavVisible === true, user.connectorsNavVisible === true), user.documentStudioNavVisible === true), user.payrollPrepNavVisible === true), user.marketingShopNavVisible === true)"), f)
      assert.equal((src.match(/withMarketingShopNavItems\(/g) ?? []).length, 1, `${f} : helper I appliqué une seule fois`)
      assert.ok(src.includes("withSupplierIntakeNavItem(withCrmAutomationNavItems(withBillingNavItems("), `${f} : chaîne E intacte`)
      assert.doesNotMatch(code(src), /MARKETING_SHOP_ENABLED|process\.env|isMarketingShopEnabled|marketing-shop-feature-flag/, f)
    }
  })
  it("layout : société pilote d'un module activé (même cible que la garde), rôle ADMIN/SUPER_ADMIN ; transmis une fois dans l'objet user", () => {
    const layout = read("src/app/(dashboard)/layout.tsx")
    assert.ok(layout.includes(`const marketingShopNavVisible = isMarketingShopEnabledForCompany(companyId) && (role === "ADMIN" || role === "SUPER_ADMIN")`))
    assert.doesNotMatch(code(layout), /isMarketingShopEnabled\(|MARKETING_SHOP_COMPANY_ID|readMarketingShopPilotCompanyId/, "aucune lecture parallèle de la cible I")
    const user = layout.slice(layout.indexOf("const user = {"), layout.indexOf("\n", layout.indexOf("const user = {")))
    assert.equal((user.match(/\bmarketingShopNavVisible\b/g) ?? []).length, 1)
  })
})
