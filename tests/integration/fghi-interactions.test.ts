/**
 * Intégration FGHI (19/11/2026) : contrôle commun CIBLÉ sur les interactions des lots F, G, H et I réunis sur 90ae644.
 * Ne remplace aucun test historique (chacun reste exécuté par son script `test:lot-*`) ; aucune suite générale.
 * - Cinq drapeaux serveur indépendants (CONNECTOR_CENTER_ENABLED, ASSISTANT_ENABLED, DOCUMENT_STUDIO_ENABLED,
 *   PAYROLL_PREP_ENABLED, MARKETING_SHOP_ENABLED), désactivés par défaut, stricts, sans effet croisé.
 * - Navigation bureau et mobile : même chaîne exacte ; 5 rôles × 32 combinaisons des cinq drapeaux × jeux de drapeaux de
 *   la base ; chaque entrée suit son seul drapeau, aucune entrée dupliquée, placement exact, entrées E conservées,
 *   catégorie de repli inchangée.
 * - Retours natifs : familles positives et négatives de chaque lot (E, F, G, H, I) et cibles interdites (exports, PDF,
 *   adresses externes, variantes).
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import type { Role } from "@prisma/client"
import {
  ASSISTANT_NAV_ITEM, AUTOMATION_NAV_ITEM, CONNECTORS_NAV_ITEM, CRM_NAV_ITEM, DOCUMENT_STUDIO_NAV_ITEM, MARKETING_NAV_ITEM, PAYROLL_PREP_NAV_ITEM, SHOP_NAV_ITEM,
  getNavItems, withAccountingNavItem, withAssistantConnectorNavItems, withBillingNavItems, withCrmAutomationNavItems, withDocumentStudioNavItem, withEquipmentNavItem,
  withFuelTicketNavItem, withHrDocumentNavItems, withMarketingShopNavItems, withPayrollPrepNavItem, withProspectionNavItem, withStockPurchasingNavItems,
  withSupplierIntakeNavItem, withWorksitePhotosNavItem, type NavItem,
} from "@/lib/navigation/nav-config"
import {
  NAV_CATEGORY_DEFINITIONS, NAV_CATEGORY_EXTENSIONS, NAV_CATEGORY_EXTENSIONS_LOT_F, NAV_CATEGORY_EXTENSIONS_LOT_G, NAV_CATEGORY_EXTENSIONS_LOT_H, NAV_CATEGORY_EXTENSIONS_LOT_I,
  groupNavItems,
} from "@/lib/navigation/nav-categories"
import { adresseApresSucces, retour, RETOUR_INITIAL } from "@/lib/actions/retour-action"
import { isConnectorCenterEnabled } from "@/lib/connectors/connector-feature-flag"
import { isAssistantEnabled } from "@/lib/assistant/assistant-feature-flag"
import { isDocumentStudioEnabled } from "@/lib/document-studio/studio-feature-flag"
import { isPayrollPrepEnabled } from "@/lib/payroll-prep/prepay-feature-flag"
import { isMarketingShopEnabled } from "@/lib/marketing-shop/marketing-shop-feature-flag"

const read = (p: string) => readFileSync(p, "utf8")
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")

// ── Drapeaux ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const FLAGS = [
  ["CONNECTOR_CENTER_ENABLED", isConnectorCenterEnabled],
  ["ASSISTANT_ENABLED", isAssistantEnabled],
  ["DOCUMENT_STUDIO_ENABLED", isDocumentStudioEnabled],
  ["PAYROLL_PREP_ENABLED", isPayrollPrepEnabled],
  ["MARKETING_SHOP_ENABLED", isMarketingShopEnabled],
] as const

describe("cinq drapeaux serveur indépendants", () => {
  it("tous désactivés par défaut ; seule la valeur exacte « true » active", () => {
    for (const [name, fn] of FLAGS) {
      assert.equal(fn({}), false, name)
      for (const v of ["1", "TRUE", "yes", " true", "true ", "on"]) assert.equal(fn({ [name]: v }), false, `${name}=${v}`)
      assert.equal(fn({ [name]: "true" }), true, name)
    }
  })
  it("aucun drapeau n'en active un autre (32 combinaisons)", () => {
    for (let n = 0; n < 1 << FLAGS.length; n++) {
      const env = Object.fromEntries(FLAGS.map(([name], i) => [name, n & (1 << i) ? "true" : undefined]))
      FLAGS.forEach(([name, fn], i) => assert.equal(fn(env), !!(n & (1 << i)), `${name} ${n}`))
    }
  })
  it("layout : cinq visibilités calculées côté serveur, rôle ADMIN/SUPER_ADMIN et société, chacune de son seul drapeau (H : société pilote en plus)", () => {
    const layout = read("src/app/(dashboard)/layout.tsx")
    // Pilote H (20/11/2026) : la visibilité H exige aussi la société pilote (configuration serveur partagée avec la garde H).
    for (const [v, expr] of [
      ["connectorsNavVisible", `isConnectorCenterEnabledForCompany(companyId) && (role === "ADMIN" || role === "SUPER_ADMIN")`],
      ["assistantNavVisible", `isAssistantEnabledForCompany(companyId) && (role === "ADMIN" || role === "SUPER_ADMIN")`],
      ["documentStudioNavVisible", `isDocumentStudioEnabled() && (role === "ADMIN" || role === "SUPER_ADMIN") && !!companyId`],
      ["payrollPrepNavVisible", `isPayrollPrepEnabledForCompany(companyId) && (role === "ADMIN" || role === "SUPER_ADMIN")`],
      ["marketingShopNavVisible", `isMarketingShopEnabledForCompany(companyId) && (role === "ADMIN" || role === "SUPER_ADMIN")`],
    ]) {
      assert.ok(layout.includes(`const ${v} = ${expr}`), v)
      const user = layout.slice(layout.indexOf("const user = {"), layout.indexOf("\n", layout.indexOf("const user = {")))
      assert.equal((user.match(new RegExp(`\\b${v}\\b`, "g")) ?? []).length, 1, `${v} transmis une fois`)
    }
    for (const f of ["src/components/layout/Sidebar.tsx", "src/components/layout/MobileNav.tsx"]) {
      assert.doesNotMatch(code(read(f)), /process\.env|_ENABLED|feature-flag/, `${f} : aucun drapeau lu côté client`)
    }
  })
})

// ── Navigation ───────────────────────────────────────────────────────────────────────────────────────────────────────
type Base = { accounting: boolean; billing: boolean; supplier: boolean; photos: boolean; equipment: boolean; hrOwn: boolean; hrManage: boolean; prospection: boolean; stock: boolean; fuel: boolean; crm: boolean; auto: boolean }
type Lots = { assistant: boolean; connectors: boolean; studio: boolean; prepay: boolean; shop: boolean }
const base = (role: Role, f: Base): NavItem[] =>
  withFuelTicketNavItem(withStockPurchasingNavItems(withProspectionNavItem(withHrDocumentNavItems(withEquipmentNavItem(withWorksitePhotosNavItem(withSupplierIntakeNavItem(withCrmAutomationNavItems(withBillingNavItems(withAccountingNavItem(getNavItems(role), f.accounting), f.billing), f.crm, f.auto), f.supplier), f.photos), f.equipment), f.hrOwn, f.hrManage), f.prospection), f.stock), f.fuel)
/** Même composition que Sidebar.tsx et MobileNav.tsx intégrés (F au plus près de la base, puis G, H, I). */
const integre = (role: Role, f: Base, l: Lots): NavItem[] =>
  withMarketingShopNavItems(withPayrollPrepNavItem(withDocumentStudioNavItem(withAssistantConnectorNavItems(base(role, f), l.assistant, l.connectors), l.studio), l.prepay), l.shop)
const ROLES: Role[] = ["SUPER_ADMIN", "ADMIN", "TEAM_LEADER", "EMPLOYEE", "CLIENT"]
const KEYS: (keyof Base)[] = ["accounting", "billing", "supplier", "photos", "equipment", "hrOwn", "hrManage", "prospection", "stock", "fuel", "crm", "auto"]
const ALL_ON = Object.fromEntries(KEYS.map((k) => [k, true])) as Base
const ALL_OFF = Object.fromEntries(KEYS.map((k) => [k, false])) as Base
const BASES: Base[] = [ALL_ON, ALL_OFF, { ...ALL_ON, crm: false, auto: false }, { ...ALL_ON, prospection: false, stock: false }, { ...ALL_OFF, auto: true, fuel: true, hrManage: true }]
const LOT_SETS: Lots[] = Array.from({ length: 32 }, (_, n) => ({ assistant: !!(n & 1), connectors: !!(n & 2), studio: !!(n & 4), prepay: !!(n & 8), shop: !!(n & 16) }))
const ENTRIES: [keyof Lots, NavItem][] = [["assistant", ASSISTANT_NAV_ITEM], ["connectors", CONNECTORS_NAV_ITEM], ["studio", DOCUMENT_STUDIO_NAV_ITEM], ["prepay", PAYROLL_PREP_NAV_ITEM], ["shop", MARKETING_NAV_ITEM], ["shop", SHOP_NAV_ITEM]]
const LOT_HREFS = new Set(ENTRIES.map(([, e]) => e.href))
const CHAIN_HEAD = "const navItems = withMarketingShopNavItems(withPayrollPrepNavItem(withDocumentStudioNavItem(withAssistantConnectorNavItems(withFuelTicketNavItem(withStockPurchasingNavItems("
const CHAIN_TAIL = "user.stockPurchasingNavVisible === true), user.fuelTicketNavVisible === true), user.assistantNavVisible === true, user.connectorsNavVisible === true), user.documentStudioNavVisible === true), user.payrollPrepNavVisible === true), user.marketingShopNavVisible === true)"

describe("navigation intégrée : bureau et mobile", () => {
  it("Sidebar.tsx et MobileNav.tsx : même chaîne exacte, chaque helper une seule fois, chaîne E intacte", () => {
    const lignes = ["src/components/layout/Sidebar.tsx", "src/components/layout/MobileNav.tsx"].map((f) => {
      const src = read(f)
      assert.ok(src.includes(CHAIN_HEAD) && src.includes(CHAIN_TAIL), f)
      assert.ok(src.includes("withSupplierIntakeNavItem(withCrmAutomationNavItems(withBillingNavItems("), `${f} : chaîne E`)
      for (const h of ["withAssistantConnectorNavItems(", "withDocumentStudioNavItem(", "withPayrollPrepNavItem(", "withMarketingShopNavItems(", "withCrmAutomationNavItems("]) assert.equal(src.split(h).length - 1, 1, `${f} : ${h}`)
      return src.split("\n").find((l) => l.includes("const navItems = "))!.trim()
    })
    assert.equal(lignes[0], lignes[1], "bureau et mobile composent à l'identique")
  })
  it("extensions de catégories distinctes, aucun href partagé ; listes de main et extension E inchangées", () => {
    const all = [...NAV_CATEGORY_EXTENSIONS, ...NAV_CATEGORY_EXTENSIONS_LOT_F, ...NAV_CATEGORY_EXTENSIONS_LOT_G, ...NAV_CATEGORY_EXTENSIONS_LOT_H, ...NAV_CATEGORY_EXTENSIONS_LOT_I]
    assert.equal(new Set(all.map((e) => e.href)).size, all.length)
    const mapped = new Set(NAV_CATEGORY_DEFINITIONS.flatMap((c) => c.hrefs))
    for (const e of all) assert.ok(!mapped.has(e.href), e.href)
    assert.deepEqual(NAV_CATEGORY_EXTENSIONS.map((e) => [e.href, e.id, e.rank]), [["/crm/opportunites", "commercial", 2.5], ["/automatisations", "administration", 1.5]])
  })
  it("5 rôles × 32 combinaisons × jeux de base : chaque entrée suit son seul drapeau, aucune entrée dupliquée ni perdue", () => {
    for (const role of ROLES) for (const b of BASES) for (const l of LOT_SETS) {
      const ctx = `${role} ${JSON.stringify(b)} ${JSON.stringify(l)}`
      const before = base(role, b), items = integre(role, b, l)
      for (const [k, e] of ENTRIES) assert.equal(items.filter((i) => i.href === e.href).length, l[k] ? 1 : 0, `${ctx} : ${e.href}`)
      assert.deepEqual(items.filter((i) => !LOT_HREFS.has(i.href)), before, `${ctx} : entrées existantes intactes, même ordre`)
      const g = groupNavItems(items), gb = groupNavItems(before)
      const flat = [...g.categories.flatMap((c) => c.items), ...g.footer]
      assert.equal(flat.length, items.length, ctx)
      assert.equal(new Set(flat.map((i) => i.href)).size, flat.length, `${ctx} : aucun doublon`)
      assert.deepEqual(g.categories.find((c) => c.id === "autres"), gb.categories.find((c) => c.id === "autres"), `${ctx} : « autres » inchangée`)
      assert.deepEqual(g.footer, gb.footer, ctx)
      const cat = new Map(g.categories.flatMap((c) => c.items.map((i) => [i.href, c.id] as const)))
      for (const c of gb.categories) for (const i of c.items) assert.equal(cat.get(i.href), c.id, `${ctx} : ${i.href}`)
      // Idempotence : réappliquer toute la chaîne n'ajoute rien.
      assert.deepEqual(withMarketingShopNavItems(withPayrollPrepNavItem(withDocumentStudioNavItem(withAssistantConnectorNavItems(items, l.assistant, l.connectors), l.studio), l.prepay), l.shop), items, ctx)
    }
  })
  it("placement exact, tous drapeaux ouverts : E conservé, F, G, H, I à leur rang", () => {
    for (const role of ROLES) {
      const g = groupNavItems(integre(role, ALL_ON, { assistant: true, connectors: true, studio: true, prepay: true, shop: true }))
      const hrefs = (id: string) => g.categories.find((c) => c.id === id)?.items.map((i) => i.href) ?? []
      const admin = hrefs("administration"), pilotage = hrefs("pilotage"), rh = hrefs("rh"), commercial = hrefs("commercial")
      // Administration : … Automatisations (E), Connecteurs (F), Document Studio (G), dans cet ordre et en fin de catégorie.
      assert.deepEqual(admin.slice(-3), ["/automatisations", "/connecteurs", "/studio-documents"], `${role} administration`)
      assert.equal(pilotage[pilotage.length - 1], "/assistant", `${role} pilotage`)
      if (pilotage.includes("/rapports")) assert.equal(pilotage[pilotage.indexOf("/assistant") - 1], "/rapports")
      if (rh.includes("/pointages")) assert.equal(rh[rh.indexOf("/pre-paie") - 1], "/pointages", `${role} rh`)
      assert.ok(rh.includes("/pre-paie"), `${role} rh`)
      assert.equal(commercial[commercial.indexOf("/marketing") + 1], "/boutique", `${role} commercial`)
      if (commercial.includes("/articles")) assert.equal(commercial[commercial.indexOf("/marketing") - 1], "/articles")
      if (commercial.includes("/opportunites")) assert.equal(commercial[commercial.indexOf("/crm/opportunites") - 1], "/opportunites", `${role} pipeline E`)
      assert.ok(g.categories.every((c) => c.id !== "autres" || c.items.every((i) => !LOT_HREFS.has(i.href))), `${role} : jamais dans « autres »`)
    }
  })
  it("navigation native : Pipeline (E), Document Studio, Pré-paie, Marketing, Boutique ; Assistant et Connecteurs par le routeur (F)", () => {
    assert.equal(CRM_NAV_ITEM.documentNavigation, true)
    for (const e of [DOCUMENT_STUDIO_NAV_ITEM, PAYROLL_PREP_NAV_ITEM, MARKETING_NAV_ITEM, SHOP_NAV_ITEM]) assert.equal(e.documentNavigation, true, e.href)
    for (const e of [ASSISTANT_NAV_ITEM, CONNECTORS_NAV_ITEM, AUTOMATION_NAV_ITEM]) assert.equal(e.documentNavigation, undefined, e.href)
  })
})

// ── Retours natifs ───────────────────────────────────────────────────────────────────────────────────────────────────
const ok = (cible?: string) => retour(true, "x", cible)
describe("retours natifs : familles E, F, G, H, I", () => {
  it("cibles admises, une famille par lot (calculées côté serveur)", () => {
    for (const c of ["/crm/opportunites/c1", "/studio-documents/t1", "/studio-documents/documents/d1", "/pre-paie", "/pre-paie/p1", "/boutique/commandes/o1"]) {
      assert.equal(adresseApresSucces(ok(c), "/dashboard"), `${c}?ok=x`, c)
    }
  })
  it("pages rouvertes sans cible, une famille par lot", () => {
    for (const p of ["/crm/opportunites", "/crm/opportunites/c1", "/automatisations", "/connecteurs", "/assistant", "/studio-documents", "/studio-documents/t1", "/studio-documents/documents/d1", "/pre-paie", "/pre-paie/p1", "/marketing", "/boutique", "/boutique/commandes/o1"]) {
      assert.equal(adresseApresSucces(ok(), p), `${p}?ok=x`, p)
    }
  })
  it("cibles refusées : pages non-fiches (E, F, I), exports, PDF, variantes, longueur, encodage, adresses externes", () => {
    for (const c of [
      "/crm/opportunites", "/automatisations", "/connecteurs", "/assistant", "/marketing", "/boutique", "/boutique/commandes", "/studio-documents", "/studio-documents/documents",
      "/pre-paie/p1/export", "/studio-documents/documents/d1/pdf", "/pre-paie/", "/connecteurs/x", `/boutique/commandes/${"a".repeat(65)}`, `/pre-paie/${"a".repeat(65)}`,
      "/studio-documents/a%2Fb", "/pre-paie/../admin", "//evil.example/pre-paie", "https://evil.example/boutique/commandes/o1", "javascript:alert(1)", "/dashboard",
    ]) assert.equal(adresseApresSucces(ok(c), "/crm/opportunites"), null, c)
  })
  it("pages refusées : modules sans retour, exports, PDF, variantes ; erreur et état initial sans navigation", () => {
    for (const p of ["/assistant/", "/assistant/x", "/dashboard", "/stock", "/connecteurs/", "/pre-paie/p1/export", "/studio-documents/documents/d1/pdf", "/studio-documents/documents", "/boutique/commandes", "/marketing/x", "/automatisations/x", "//x"]) {
      assert.equal(adresseApresSucces(ok(), p), null, p)
    }
    assert.equal(adresseApresSucces(retour(false, "x"), "/pre-paie"), null)
    assert.equal(adresseApresSucces(RETOUR_INITIAL, "/boutique"), null)
  })
  it("message hostile : encodé dans « ok », chemin intact", () => {
    const u = new URL(adresseApresSucces(retour(true, "a&erreur=x#h<script>", "/boutique/commandes/o1"), "/boutique")!, "http://h")
    assert.equal(u.pathname, "/boutique/commandes/o1")
    assert.deepEqual([...u.searchParams.keys()], ["ok"])
  })
  it("source : chaque liste conservée à l'identique et distincte", () => {
    const src = read("src/lib/actions/retour-action.ts")
    for (const l of [
      "const FICHE = /^\\/crm\\/opportunites\\/[A-Za-z0-9_-]{1,64}$/",
      "const PAGES_LOT_E = /^\\/(?:crm\\/opportunites(?:\\/[A-Za-z0-9_-]{1,64})?|automatisations)$/",
      "const PAGES_LOT_F = /^\\/connecteurs$/",
      // Espace PDF du Studio (20/11/2026) : fiches « /studio-documents/fichiers/<id> » ajoutées aux listes G, même règle.
      "const FICHES_LOT_G = /^\\/studio-documents\\/(?:(?:documents|fichiers)\\/[A-Za-z0-9_-]{1,64}|(?!(?:documents|fichiers)$)[A-Za-z0-9_-]{1,64})$/",
      "const PAGES_LOT_G = /^\\/studio-documents(?:\\/(?:(?:documents|fichiers)\\/[A-Za-z0-9_-]{1,64}|(?!(?:documents|fichiers)$)[A-Za-z0-9_-]{1,64}))?$/",
      "const PAGES_LOT_H = /^\\/pre-paie(?:\\/[A-Za-z0-9_-]{1,64})?$/",
      "const FICHES_LOT_I = /^\\/boutique\\/commandes\\/[A-Za-z0-9_-]{1,64}$/",
      "const PAGES_LOT_I = /^\\/(?:marketing|boutique(?:\\/commandes\\/[A-Za-z0-9_-]{1,64})?)$/",
    ]) assert.equal(src.split(l).length - 1, 1, l)
  })
})

// ── Migrations ───────────────────────────────────────────────────────────────────────────────────────────────────────
describe("migrations F, G, H, I", () => {
  it("quatre migrations historiques à l'octet, dans l'ordre, après toutes celles de main ; aucune migration D", async () => {
    const { readdirSync } = await import("node:fs")
    const { createHash } = await import("node:crypto")
    const dirs = readdirSync("prisma/migrations").filter((d) => /^\d{14}_/.test(d)).sort()
    const lots = [
      ["20261119120000_v2_lot_f_connectors_assistant", "9c34d988366c77dadef8732346555a76bb452c3f1a472b328260c6cf709a2e9b"],
      ["20261119130000_v2_lot_g_document_studio", "7736f8eb60f572c0b254ee0ebe909baa9c26569083c28edb2a6b24e9f2b3a4c5"],
      ["20261119140000_v2_lot_h_payroll_prep", "6bf15b8f9a0b10657da801fdfa57e4baab45475f581afb2fde3a087bd0115ece"],
      ["20261119150000_v2_lot_i_marketing_shop", "afc78dda37a480096c080a79e6793d97cdd35d45732a08d688a57a3257854aad"],
    ]
    // Les quatre lots se suivent dans l'ordre, directement après la dernière migration de main 90ae644 ; les migrations
    // ultérieures hors lots (photos, espace PDF du Studio…) viennent après et ne sont pas des lots.
    const i = dirs.indexOf(lots[0][0])
    assert.deepEqual(dirs.slice(i, i + 4), lots.map(([d]) => d))
    assert.equal(dirs[i - 1], "20261117120000_vehicle_tour_auto_km")
    assert.deepEqual(dirs.filter((d) => /_v2_lot_[fghi]_/.test(d)), lots.map(([d]) => d))
    for (const [d, sha] of lots) assert.equal(createHash("sha256").update(readFileSync(`prisma/migrations/${d}/migration.sql`)).digest("hex"), sha, d)
    assert.ok(dirs.every((d) => !/lot_d|reserve/.test(d)))
  })
})
