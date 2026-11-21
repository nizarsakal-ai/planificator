/**
 * Lot H Planificator V2 (portage sur 90ae644) : navigation « Pré-paie » (PAYROLL_PREP_ENABLED, catégorie Équipes & RH,
 * /pre-paie).
 * - Drapeau désactivé ⇒ navigation de main + E strictement inchangée (tous rôles × combinaisons des drapeaux existants).
 * - Drapeau activé ⇒ une seule entrée, dans Équipes & RH, après « Pointages » quand il est présent ; toute entrée existante
 *   garde sa catégorie ; la catégorie de repli « autres » est identique avec et sans H.
 * - Rattachement par une extension DISTINCTE ; câblage identique dans Sidebar.tsx et MobileNav.tsx (helper H le plus
 *   extérieur) ; drapeau lu côté serveur (layout). Données synthétiques uniquement, aucune base.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import type { Role } from "@prisma/client"
import {
  PAYROLL_PREP_NAV_ITEM, getActiveNavHref, getNavItems, withAccountingNavItem, withBillingNavItems, withCrmAutomationNavItems, withEquipmentNavItem,
  withFuelTicketNavItem, withHrDocumentNavItems, withPayrollPrepNavItem, withProspectionNavItem, withStockPurchasingNavItems, withSupplierIntakeNavItem,
  withWorksitePhotosNavItem, type NavItem,
} from "@/lib/navigation/nav-config"
import { NAV_CATEGORY_DEFINITIONS, NAV_CATEGORY_EXTENSIONS, NAV_CATEGORY_EXTENSIONS_LOT_H, getActiveNavCategoryId, groupNavItems } from "@/lib/navigation/nav-categories"

const read = (p: string) => readFileSync(p, "utf8")
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")

type Flags = { accounting: boolean; billing: boolean; supplier: boolean; photos: boolean; equipment: boolean; hrOwn: boolean; hrManage: boolean; prospection: boolean; stock: boolean; fuel: boolean; crm: boolean; auto: boolean }
/** Composition de Sidebar.tsx / MobileNav.tsx sur 90ae644 (main + lot E), sans le lot H. */
function avantH(role: Role, f: Flags): NavItem[] {
  return withFuelTicketNavItem(withStockPurchasingNavItems(withProspectionNavItem(withHrDocumentNavItems(withEquipmentNavItem(withWorksitePhotosNavItem(withSupplierIntakeNavItem(withCrmAutomationNavItems(withBillingNavItems(withAccountingNavItem(getNavItems(role), f.accounting), f.billing), f.crm, f.auto), f.supplier), f.photos), f.equipment), f.hrOwn, f.hrManage), f.prospection), f.stock), f.fuel)
}
const avecH = (role: Role, f: Flags, prepay: boolean) => withPayrollPrepNavItem(avantH(role, f), prepay)
const ROLES: Role[] = ["SUPER_ADMIN", "ADMIN", "TEAM_LEADER", "EMPLOYEE", "CLIENT"]
const KEYS: (keyof Flags)[] = ["accounting", "billing", "supplier", "photos", "equipment", "hrOwn", "hrManage", "prospection", "stock", "fuel", "crm", "auto"]
const FLAG_SETS: Flags[] = Array.from({ length: 1 << KEYS.length }, (_, n) => Object.fromEntries(KEYS.map((k, i) => [k, !!(n & (1 << i))])) as Flags)
const ALL_ON = FLAG_SETS[FLAG_SETS.length - 1]

describe("lot H : drapeau désactivé ⇒ navigation inchangée", () => {
  for (const role of ROLES) {
    it(`${role} × ${FLAG_SETS.length} combinaisons : mêmes entrées, même ordre, mêmes catégories`, () => {
      for (const flags of FLAG_SETS) {
        const before = avantH(role, flags), after = avecH(role, flags, false)
        assert.deepEqual(after, before, `${role} ${JSON.stringify(flags)}`)
        assert.deepEqual(groupNavItems(after), groupNavItems(before))
      }
    })
  }
  it("seule la valeur booléenne true rend visible ; aucune mutation de l'entrée", () => {
    const base = avantH("ADMIN", ALL_ON), copy = [...base]
    for (const v of ["true", 1, "oui", null, undefined]) assert.deepEqual(withPayrollPrepNavItem(base, v as unknown as boolean), base, String(v))
    assert.deepEqual(base, copy)
  })
})

describe("lot H : drapeau activé", () => {
  it("une entrée « Pré-paie » dans Équipes & RH ; entrées existantes dans leur catégorie ; « autres » identique ; sans doublon", () => {
    for (const role of ROLES) for (const flags of FLAG_SETS) {
      const ctx = `${role} ${JSON.stringify(flags)}`
      const before = avantH(role, flags), composed = avecH(role, flags, true)
      assert.equal(composed.length, before.length + 1)
      assert.deepEqual(composed.filter((i) => i !== PAYROLL_PREP_NAV_ITEM), before, `${ctx} : ordre relatif conservé`)
      const grouped = groupNavItems(composed), groupedBefore = groupNavItems(before)
      const regrouped = [...grouped.categories.flatMap((c) => c.items), ...grouped.footer]
      assert.equal(regrouped.length, composed.length)
      assert.equal(new Set(regrouped.map((i) => i.href)).size, regrouped.length, `${ctx} : aucun doublon`)
      assert.deepEqual(grouped.categories.find((c) => c.id === "autres"), groupedBefore.categories.find((c) => c.id === "autres"), `${ctx} : « autres » inchangée`)
      const categorieDe = (g: typeof grouped) => new Map(g.categories.flatMap((c) => c.items.map((i) => [i.href, c.id] as const)))
      const avant = categorieDe(groupedBefore), apres = categorieDe(grouped)
      for (const [href, id] of avant) assert.equal(apres.get(href), id, `${ctx} : ${href} garde sa catégorie`)
      assert.deepEqual([...apres.keys()].filter((h) => !avant.has(h)), ["/pre-paie"], `${ctx} : seule entrée ajoutée`)
      assert.equal(apres.get("/pre-paie"), "rh")
      assert.deepEqual(grouped.footer, groupedBefore.footer, `${ctx} : pied inchangé`)
      const rh = grouped.categories.find((c) => c.id === "rh")!.items.map((i) => i.href)
      if (rh.includes("/pointages")) assert.equal(rh[rh.indexOf("/pre-paie") - 1], "/pointages", `${ctx} : après Pointages`)
      assert.deepEqual(groupedBefore.categories.filter((c) => c.id !== "rh"), grouped.categories.filter((c) => c.id !== "rh"), `${ctx} : autres catégories inchangées`)
    }
  })
  it("entrée exacte : libellé, route, navigation native du document ; idempotent ; avant « Profil »", () => {
    assert.deepEqual({ ...PAYROLL_PREP_NAV_ITEM, icon: undefined }, { label: "Pré-paie", href: "/pre-paie", icon: undefined, documentNavigation: true })
    const once = avecH("SUPER_ADMIN", ALL_ON, true)
    assert.deepEqual(withPayrollPrepNavItem(once, true), once)
    const base = getNavItems("ADMIN"), on = withPayrollPrepNavItem(base, true)
    assert.equal(on.length, base.length + 1)
    assert.equal(on.indexOf(PAYROLL_PREP_NAV_ITEM), on.findIndex((i) => i.href === "/profil") - 1)
  })
  it("entrée active : liste et fiche d'une période ⇒ Pré-paie (Équipes & RH)", () => {
    const items = avecH("ADMIN", ALL_ON, true)
    for (const p of ["/pre-paie", "/pre-paie/p1"]) assert.equal(getActiveNavHref(items, p), "/pre-paie", p)
    assert.equal(getActiveNavCategoryId(groupNavItems(items), "/pre-paie"), "rh")
  })
})

describe("lot H : catégories et câblage", () => {
  it("listes de main et extension E inchangées ; extension H distincte et exacte", () => {
    assert.deepEqual(NAV_CATEGORY_DEFINITIONS.find((c) => c.id === "rh")?.hrefs, ["/mes-documents", "/rh/documents", "/employes", "/equipes", "/planning/equipe", "/absences", "/mes-absences", "/pointages", "/pointage", "/notes-de-frais", "/mes-notes-de-frais"])
    assert.deepEqual(NAV_CATEGORY_EXTENSIONS.map((e) => [e.href, e.id]), [["/crm/opportunites", "commercial"], ["/automatisations", "administration"]])
    assert.deepEqual(NAV_CATEGORY_EXTENSIONS_LOT_H.map((e) => [e.href, e.id, e.rank]), [["/pre-paie", "rh", 7.5]])
  })
  it("Sidebar.tsx et MobileNav.tsx : helper H dans la chaîne intégrée FGHI, visibilité serveur ; aucun drapeau lu côté client", () => {
    // Intégration FGHI : la chaîne exacte (F au plus près de la base, puis G, H, I) remplace « H le plus extérieur ».
    for (const f of ["src/components/layout/Sidebar.tsx", "src/components/layout/MobileNav.tsx"]) {
      const src = read(f)
      assert.ok(src.includes("const navItems = withMarketingShopNavItems(withPayrollPrepNavItem(withDocumentStudioNavItem(withAssistantConnectorNavItems(withFuelTicketNavItem(withStockPurchasingNavItems("), f)
      assert.ok(src.includes("user.stockPurchasingNavVisible === true), user.fuelTicketNavVisible === true), user.assistantNavVisible === true, user.connectorsNavVisible === true), user.documentStudioNavVisible === true), user.payrollPrepNavVisible === true), user.marketingShopNavVisible === true)"), f)
      assert.equal((src.match(/withPayrollPrepNavItem\(/g) ?? []).length, 1, `${f} : helper H appliqué une seule fois`)
      assert.ok(src.includes("withSupplierIntakeNavItem(withCrmAutomationNavItems(withBillingNavItems("), `${f} : chaîne E intacte`)
      assert.doesNotMatch(code(src), /PAYROLL_PREP_ENABLED|process\.env|isPayrollPrepEnabled|prepay-feature-flag/, `${f} : aucun drapeau lu côté client`)
    }
  })
  it("layout : drapeau et société pilote (configuration partagée avec la garde), rôle ADMIN/SUPER_ADMIN ; transmis une fois dans l'objet user", () => {
    const layout = read("src/app/(dashboard)/layout.tsx")
    assert.ok(layout.includes(`const payrollPrepNavVisible = isPayrollPrepEnabledForCompany(companyId) && (role === "ADMIN" || role === "SUPER_ADMIN")`))
    assert.ok(layout.includes(`import { isPayrollPrepEnabledForCompany } from "@/lib/payroll-prep/prepay-feature-flag"`))
    assert.doesNotMatch(code(layout), /isPayrollPrepEnabled\(|PAYROLL_PREP_COMPANY_ID|readPayrollPrepPilotCompanyId/, "aucune lecture parallèle de la configuration H")
    const user = layout.slice(layout.indexOf("const user = {"), layout.indexOf("\n", layout.indexOf("const user = {")))
    assert.equal((user.match(/\bpayrollPrepNavVisible\b/g) ?? []).length, 1)
  })
})
