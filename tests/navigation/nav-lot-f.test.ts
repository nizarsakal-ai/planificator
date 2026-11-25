/**
 * Lot F Planificator V2 (portage sur ab987847, 19/11/2026) : navigation. Logique pure et câblage statique, sans base ni
 * réseau.
 * - Drapeaux F coupés : composition STRICTEMENT identique à celle de la base (menus existants, lot E, ticket carburant).
 * - Drapeaux F ouverts : « Assistant » dans Pilotage (après Rapports), « Connecteurs » dans Administration (après
 *   Automatisations), une seule fois chacun ; navigation document toujours réservée au « Pipeline commercial » (E4).
 * - Listes et extensions du lot E inchangées ; câblage identique dans Sidebar.tsx et MobileNav.tsx ; drapeaux lus
 *   côté serveur seulement.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import type { Role } from "@prisma/client"
import {
  ASSISTANT_NAV_ITEM, CONNECTORS_NAV_ITEM, CRM_NAV_ITEM, getNavItems, withAccountingNavItem, withAssistantConnectorNavItems, withBillingNavItems,
  withCrmAutomationNavItems, withEquipmentNavItem, withFuelTicketNavItem, withHrDocumentNavItems, withProspectionNavItem, withStockPurchasingNavItems,
  withSupplierIntakeNavItem, withWorksitePhotosNavItem,
} from "@/lib/navigation/nav-config"
import { NAV_CATEGORY_DEFINITIONS, NAV_CATEGORY_EXTENSIONS, NAV_CATEGORY_EXTENSIONS_LOT_F, groupNavItems, navCategoryOf } from "@/lib/navigation/nav-categories"

const ROLES: Role[] = ["SUPER_ADMIN", "ADMIN", "TEAM_LEADER", "EMPLOYEE", "CLIENT"]
const read = (p: string) => readFileSync(p, "utf8")
/** Composition de la base ab987847 (Sidebar.tsx / MobileNav.tsx avant le lot F), tous drapeaux de la base ouverts. */
const base = (role: Role) => withFuelTicketNavItem(withStockPurchasingNavItems(withProspectionNavItem(withHrDocumentNavItems(withEquipmentNavItem(withWorksitePhotosNavItem(withSupplierIntakeNavItem(withCrmAutomationNavItems(withBillingNavItems(withAccountingNavItem(getNavItems(role), true), true), true, true), true), true), true), true, true), true), true), true)
const lotF = (role: Role, assistant: boolean, connectors: boolean) => withAssistantConnectorNavItems(base(role), assistant, connectors)

describe("lot F : composition", () => {
  it("drapeaux F coupés (ou non strictement « true ») : composition identique à la base pour chaque rôle", () => {
    for (const role of ROLES) {
      assert.deepEqual(lotF(role, false, false), base(role), role)
      assert.deepEqual(withAssistantConnectorNavItems(base(role), "true" as unknown as boolean, 1 as unknown as boolean), base(role), role)
    }
  })
  it("drapeaux ouverts : deux entrées ajoutées avant « Mon profil », une seule fois (idempotent)", () => {
    const items = lotF("ADMIN", true, true)
    const hrefs = items.map((i) => i.href)
    assert.equal(hrefs.filter((h) => h === "/assistant").length, 1)
    assert.equal(hrefs.filter((h) => h === "/connecteurs").length, 1)
    const profile = hrefs.indexOf("/profil")
    if (profile >= 0) assert.ok(hrefs.indexOf("/assistant") < profile && hrefs.indexOf("/connecteurs") < profile)
    assert.deepEqual(withAssistantConnectorNavItems(items, true, true), items, "idempotent")
    assert.deepEqual(items.filter((i) => i.href !== "/assistant" && i.href !== "/connecteurs"), base("ADMIN"), "aucune entrée existante retirée ni déplacée")
  })
  it("chaque entrée suit son seul drapeau", () => {
    assert.deepEqual(lotF("ADMIN", true, false).filter((i) => i.href === "/assistant" || i.href === "/connecteurs"), [ASSISTANT_NAV_ITEM])
    assert.deepEqual(lotF("ADMIN", false, true).filter((i) => i.href === "/assistant" || i.href === "/connecteurs"), [CONNECTORS_NAV_ITEM])
  })
  it("navigation document toujours réservée au « Pipeline commercial » (correctif E4)", () => {
    assert.equal(ASSISTANT_NAV_ITEM.documentNavigation, undefined)
    assert.equal(CONNECTORS_NAV_ITEM.documentNavigation, undefined)
    for (const role of ROLES) assert.ok(lotF(role, true, true).filter((i) => i.documentNavigation).every((i) => i === CRM_NAV_ITEM), role)
  })
})

describe("lot F : catégories", () => {
  it("Assistant dans Pilotage après Rapports ; Connecteurs dans Administration après Automatisations", () => {
    assert.equal(navCategoryOf("/assistant"), "pilotage")
    assert.equal(navCategoryOf("/connecteurs"), "administration")
    const g = groupNavItems(lotF("ADMIN", true, true))
    const pilotage = g.categories.find((c) => c.id === "pilotage")!.items.map((i) => i.href)
    const admin = g.categories.find((c) => c.id === "administration")!.items.map((i) => i.href)
    assert.equal(pilotage[pilotage.length - 1], "/assistant")
    if (pilotage.includes("/rapports")) assert.equal(pilotage[pilotage.indexOf("/assistant") - 1], "/rapports")
    assert.equal(admin[admin.length - 1], "/connecteurs")
    assert.equal(admin[admin.indexOf("/connecteurs") - 1], "/automatisations")
    assert.ok(g.categories.every((c) => c.id !== "autres" || c.items.every((i) => i.href !== "/assistant" && i.href !== "/connecteurs")), "jamais dans « Autres »")
  })
  it("listes de la base et extensions du lot E inchangées ; rattachements F séparés", () => {
    assert.deepEqual(NAV_CATEGORY_DEFINITIONS.find((c) => c.id === "pilotage")?.hrefs, ["/dashboard", "/rapports"])
    assert.deepEqual(NAV_CATEGORY_DEFINITIONS.find((c) => c.id === "administration")?.hrefs, ["/super-admin/entreprises", "/parametres"])
    assert.deepEqual(NAV_CATEGORY_EXTENSIONS.map((e) => [e.href, e.id]), [["/crm/opportunites", "commercial"], ["/automatisations", "administration"]])
    assert.deepEqual(NAV_CATEGORY_EXTENSIONS_LOT_F.map((e) => [e.href, e.id]), [["/assistant", "pilotage"], ["/connecteurs", "administration"]])
  })
  it("drapeaux F coupés : regroupement identique à celui de la base", () => {
    for (const role of ROLES) assert.deepEqual(groupNavItems(lotF(role, false, false)), groupNavItems(base(role)), role)
  })
})

describe("lot F : câblage", () => {
  it("Sidebar.tsx et MobileNav.tsx : enveloppe F extérieure, chaîne de la base (lot E compris) intacte, aucun drapeau lu côté client", () => {
    for (const f of ["src/components/layout/Sidebar.tsx", "src/components/layout/MobileNav.tsx"]) {
      const src = read(f)
      assert.ok(src.includes("withAssistantConnectorNavItems(withFuelTicketNavItem(withStockPurchasingNavItems("), f)
      assert.ok(src.includes("withSupplierIntakeNavItem(withCrmAutomationNavItems(withBillingNavItems("), `${f} : chaîne du lot E intacte`)
      assert.ok(src.includes("user.fuelTicketNavVisible === true), user.assistantNavVisible === true && user.assistantMenuReplaced !== true, user.connectorsNavVisible === true)"), f)
      assert.doesNotMatch(src, /ASSISTANT_ENABLED|CONNECTOR_CENTER_ENABLED/, `${f} : aucun drapeau lu côté client`)
    }
  })
  it("layout : logo #418 et drapeaux E conservés", () => {
    const layout = read("src/app/(dashboard)/layout.tsx")
    assert.ok(layout.includes("const companyLogo = companyLogoDisplaySrc(company?.logoUrl)"), "correctif #418 intact")
    assert.ok(layout.includes(`const crmNavVisible = isCrmEnabled() && (role === "ADMIN" || role === "SUPER_ADMIN") && !!companyId`))
    assert.ok(layout.includes(`const automationNavVisible = isAutomationsEnabled() && (role === "ADMIN" || role === "SUPER_ADMIN") && !!companyId`))
  })
})
