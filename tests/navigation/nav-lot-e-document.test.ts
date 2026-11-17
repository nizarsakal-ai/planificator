// Correctif E4 : seule l'entrée « Pipeline commercial » est ouverte par navigation native du document ; tous les autres menus
// (autres modules, Automatisations, ticket carburant de main 5e80cd4) gardent la transition du routeur client.
import { test } from "node:test"
import assert from "node:assert/strict"
import type { Role } from "@prisma/client"
import { AUTOMATION_NAV_ITEM, CRM_NAV_ITEM, getNavItems, withAccountingNavItem, withBillingNavItems, withCrmAutomationNavItems, withEquipmentNavItem, withFuelTicketNavItem, withHrDocumentNavItems, withProspectionNavItem, withStockPurchasingNavItems, withSupplierIntakeNavItem, withWorksitePhotosNavItem } from "@/lib/navigation/nav-config"

const ROLES: Role[] = ["SUPER_ADMIN", "ADMIN", "TEAM_LEADER", "EMPLOYEE", "CLIENT"]
// Composition exacte de Sidebar.tsx / MobileNav.tsx sur main 5e80cd4 + lot E, tous drapeaux ouverts.
const tout = (role: Role) => withFuelTicketNavItem(withStockPurchasingNavItems(withProspectionNavItem(withHrDocumentNavItems(withEquipmentNavItem(withWorksitePhotosNavItem(withSupplierIntakeNavItem(withCrmAutomationNavItems(withBillingNavItems(withAccountingNavItem(getNavItems(role), true), true), true, true), true), true), true), true, true), true), true), true)

test("navigation document : « Pipeline commercial » seulement", () => {
  assert.equal(CRM_NAV_ITEM.documentNavigation, true)
  assert.equal(AUTOMATION_NAV_ITEM.documentNavigation, undefined)
  for (const role of ROLES) {
    const doc = tout(role).filter((i) => i.documentNavigation)
    assert.ok(doc.every((i) => i === CRM_NAV_ITEM), role)
  }
})
test("drapeau CRM coupé : aucune entrée en navigation document", () => {
  for (const role of ROLES) {
    const sans = withCrmAutomationNavItems(getNavItems(role), false, true)
    assert.equal(sans.filter((i) => i.documentNavigation).length, 0, role)
  }
})
