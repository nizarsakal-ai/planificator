/**
 * Lot G Planificator V2 (portage sur ef36578f) : navigation « Document Studio » (DOCUMENT_STUDIO_ENABLED, catégorie
 * Administration, /studio-documents).
 * - Drapeau désactivé ⇒ navigation de main + E strictement inchangée (tous rôles × combinaisons des drapeaux existants).
 * - Drapeau activé ⇒ une seule entrée, dans Administration, après « Automatisations », navigation native du document.
 * - Rattachement par une extension DISTINCTE : listes de main et extension du lot E inchangées.
 * - Câblage identique dans Sidebar.tsx et MobileNav.tsx (helper G le plus extérieur) ; drapeau lu côté serveur (layout).
 * Données synthétiques uniquement, aucune base.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import type { Role } from "@prisma/client"
import {
  DOCUMENT_STUDIO_NAV_ITEM, getActiveNavHref, getNavItems, withAccountingNavItem, withBillingNavItems, withCrmAutomationNavItems, withDocumentStudioNavItem,
  withEquipmentNavItem, withFuelTicketNavItem, withHrDocumentNavItems, withProspectionNavItem, withStockPurchasingNavItems, withSupplierIntakeNavItem,
  withWorksitePhotosNavItem, type NavItem,
} from "@/lib/navigation/nav-config"
import { NAV_CATEGORY_DEFINITIONS, NAV_CATEGORY_EXTENSIONS, NAV_CATEGORY_EXTENSIONS_LOT_G, getActiveNavCategoryId, groupNavItems } from "@/lib/navigation/nav-categories"

const read = (p: string) => readFileSync(p, "utf8")
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")

type Flags = { accounting: boolean; billing: boolean; supplier: boolean; photos: boolean; equipment: boolean; hrOwn: boolean; hrManage: boolean; prospection: boolean; stock: boolean; fuel: boolean; crm: boolean; auto: boolean }
/** Composition de Sidebar.tsx / MobileNav.tsx sur ef36578f (main + lot E), sans le lot G. */
function avantG(role: Role, f: Flags): NavItem[] {
  return withFuelTicketNavItem(withStockPurchasingNavItems(withProspectionNavItem(withHrDocumentNavItems(withEquipmentNavItem(withWorksitePhotosNavItem(withSupplierIntakeNavItem(withCrmAutomationNavItems(withBillingNavItems(withAccountingNavItem(getNavItems(role), f.accounting), f.billing), f.crm, f.auto), f.supplier), f.photos), f.equipment), f.hrOwn, f.hrManage), f.prospection), f.stock), f.fuel)
}
/** Composition avec le lot G : même chaîne, helper G le plus extérieur. */
const avecG = (role: Role, f: Flags, studio: boolean) => withDocumentStudioNavItem(avantG(role, f), studio)
const ROLES: Role[] = ["SUPER_ADMIN", "ADMIN", "TEAM_LEADER", "EMPLOYEE", "CLIENT"]
const KEYS: (keyof Flags)[] = ["accounting", "billing", "supplier", "photos", "equipment", "hrOwn", "hrManage", "prospection", "stock", "fuel", "crm", "auto"]
const FLAG_SETS: Flags[] = Array.from({ length: 1 << KEYS.length }, (_, n) => Object.fromEntries(KEYS.map((k, i) => [k, !!(n & (1 << i))])) as Flags)
const ALL_ON = FLAG_SETS[FLAG_SETS.length - 1]

describe("lot G : drapeau désactivé ⇒ navigation inchangée", () => {
  for (const role of ROLES) {
    it(`${role} × ${FLAG_SETS.length} combinaisons : mêmes entrées, même ordre, mêmes catégories`, () => {
      for (const flags of FLAG_SETS) {
        const before = avantG(role, flags), after = avecG(role, flags, false)
        assert.deepEqual(after, before, `${role} ${JSON.stringify(flags)}`)
        assert.deepEqual(groupNavItems(after), groupNavItems(before))
      }
    })
  }
  it("seule la valeur booléenne true rend visible ; aucune mutation de l'entrée", () => {
    const base = avantG("ADMIN", ALL_ON), copy = [...base]
    for (const v of ["true", 1, "oui", null, undefined]) assert.deepEqual(withDocumentStudioNavItem(base, v as unknown as boolean), base, String(v))
    assert.deepEqual(base, copy)
  })
})

describe("lot G : drapeau activé", () => {
  it("une entrée « Document Studio » dans Administration, après Automatisations, sans perte ni doublon ; ordre existant conservé", () => {
    for (const role of ROLES) for (const flags of FLAG_SETS) {
      const before = avantG(role, flags), composed = avecG(role, flags, true)
      assert.equal(composed.length, before.length + 1)
      assert.deepEqual(composed.filter((i) => i !== DOCUMENT_STUDIO_NAV_ITEM), before, "ordre relatif des entrées existantes conservé")
      const grouped = groupNavItems(composed)
      const regrouped = [...grouped.categories.flatMap((c) => c.items), ...grouped.footer]
      assert.equal(regrouped.length, composed.length)
      assert.equal(new Set(regrouped.map((i) => i.href)).size, regrouped.length, "aucun doublon")
      // v2 (recette Codex) : la catégorie de repli « autres » peut déjà exister sur ef36578f (ex. /ticket-carburant pour
      // SUPER_ADMIN avec fuel) ; elle doit être IDENTIQUE avec et sans G, et chaque entrée existante garder sa catégorie.
      const groupedBefore = groupNavItems(before)
      const ctx = `${role} ${JSON.stringify(flags)}`
      assert.deepEqual(grouped.categories.find((c) => c.id === "autres"), groupedBefore.categories.find((c) => c.id === "autres"), `${ctx} : « autres » inchangée`)
      assert.ok(!(grouped.categories.find((c) => c.id === "autres")?.items ?? []).some((i) => i.href === "/studio-documents"), `${ctx} : G jamais dans « autres »`)
      const categorieDe = (g: typeof grouped) => new Map(g.categories.flatMap((c) => c.items.map((i) => [i.href, c.id] as const)))
      const avantMap = categorieDe(groupedBefore), apresMap = categorieDe(grouped)
      for (const [href, id] of avantMap) assert.equal(apresMap.get(href), id, `${ctx} : ${href} garde sa catégorie`)
      assert.deepEqual([...apresMap.keys()].filter((h) => !avantMap.has(h)), ["/studio-documents"], `${ctx} : seule entrée ajoutée`)
      assert.equal(apresMap.get("/studio-documents"), "administration")
      assert.deepEqual(grouped.footer, groupedBefore.footer, `${ctx} : pied inchangé`)
      const admin = grouped.categories.find((c) => c.id === "administration")!.items.map((i) => i.href)
      assert.equal(admin[admin.length - 1], "/studio-documents", `${role} : dernière entrée d'Administration`)
      if (admin.includes("/automatisations")) assert.equal(admin[admin.indexOf("/studio-documents") - 1], "/automatisations")
      assert.deepEqual(groupNavItems(before).categories.filter((c) => c.id !== "administration"), grouped.categories.filter((c) => c.id !== "administration"), "autres catégories inchangées")
    }
  })
  it("entrée exacte : libellé, route, navigation native du document (motif E4) ; idempotent", () => {
    assert.deepEqual({ ...DOCUMENT_STUDIO_NAV_ITEM, icon: undefined }, { label: "Document Studio", href: "/studio-documents", icon: undefined, documentNavigation: true })
    const once = avecG("SUPER_ADMIN", ALL_ON, true)
    assert.deepEqual(withDocumentStudioNavItem(once, true), once)
    const base = getNavItems("ADMIN"), on = withDocumentStudioNavItem(base, true)
    assert.equal(on.length, base.length + 1)
    assert.equal(on.indexOf(DOCUMENT_STUDIO_NAV_ITEM), on.findIndex((i) => i.href === "/profil") - 1, "avant « Profil »")
  })
  it("entrée active : liste, modèle, document généré ⇒ Document Studio (Administration)", () => {
    const items = avecG("ADMIN", ALL_ON, true)
    for (const p of ["/studio-documents", "/studio-documents/t1", "/studio-documents/documents/d1"]) {
      assert.equal(getActiveNavHref(items, p), "/studio-documents", p)
    }
    assert.equal(getActiveNavCategoryId(groupNavItems(items), "/studio-documents"), "administration")
    assert.equal(getActiveNavHref(items, "/automatisations"), "/automatisations")
  })
})

describe("lot G : catégories et câblage", () => {
  it("listes de main et extension E inchangées ; extension G distincte et exacte", () => {
    assert.deepEqual(NAV_CATEGORY_DEFINITIONS.find((c) => c.id === "administration")?.hrefs, ["/super-admin/entreprises", "/parametres"])
    assert.deepEqual(NAV_CATEGORY_EXTENSIONS.map((e) => [e.href, e.id]), [["/crm/opportunites", "commercial"], ["/automatisations", "administration"]])
    assert.deepEqual(NAV_CATEGORY_EXTENSIONS_LOT_G.map((e) => [e.href, e.id, e.rank]), [["/studio-documents", "administration", 2.5]])
  })
  it("Sidebar.tsx et MobileNav.tsx : helper G dans la chaîne intégrée FGHI, visibilité serveur ; aucun drapeau lu côté client", () => {
    // Intégration FGHI : la chaîne exacte (F au plus près de la base, puis G, H, I) remplace « G le plus extérieur ».
    for (const f of ["src/components/layout/Sidebar.tsx", "src/components/layout/MobileNav.tsx"]) {
      const src = read(f)
      assert.ok(src.includes("const navItems = withMarketingShopNavItems(withPayrollPrepNavItem(withDocumentStudioNavItem(withAssistantConnectorNavItems(withFuelTicketNavItem(withStockPurchasingNavItems("), f)
      assert.ok(src.includes("user.stockPurchasingNavVisible === true), user.fuelTicketNavVisible === true), user.assistantNavVisible === true && user.assistantMenuReplaced !== true, user.connectorsNavVisible === true), user.documentStudioNavVisible === true), user.payrollPrepNavVisible === true), user.marketingShopNavVisible === true)"), f)
      assert.equal((src.match(/withDocumentStudioNavItem\(/g) ?? []).length, 1, `${f} : helper G appliqué une seule fois`)
      assert.ok(src.includes("withSupplierIntakeNavItem(withCrmAutomationNavItems(withBillingNavItems("), `${f} : chaîne E intacte`)
      assert.doesNotMatch(code(src), /DOCUMENT_STUDIO_ENABLED|process\.env|isDocumentStudioEnabled|studio-feature-flag/, `${f} : aucun drapeau lu côté client`)
    }
  })
  it("layout : drapeau, rôle ADMIN/SUPER_ADMIN et société ; transmis une fois dans l'objet user", () => {
    const layout = read("src/app/(dashboard)/layout.tsx")
    assert.ok(layout.includes(`const documentStudioNavVisible = isDocumentStudioEnabled() && (role === "ADMIN" || role === "SUPER_ADMIN") && !!companyId`))
    const user = layout.slice(layout.indexOf("const user = {"), layout.indexOf("\n", layout.indexOf("const user = {")))
    assert.equal((user.match(/\bdocumentStudioNavVisible\b/g) ?? []).length, 1)
    assert.ok(layout.includes(`import { isDocumentStudioEnabled } from "@/lib/document-studio/studio-feature-flag"`))
  })
})
