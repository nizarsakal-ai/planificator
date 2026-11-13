/**
 * L1a Planificator V2 (lot A reporté sur main) — entrées « Stock » et « Achats » dans la navigation de PRODUCTION.
 * Drapeau désactivé ⇒ navigation strictement identique à la composition de production (tous rôles × drapeaux existants).
 * Drapeau activé ⇒ deux entrées dans « Chantiers & terrain », jamais dans « Autres », sans doublon ni perte.
 * Plus : câblage Sidebar/MobileNav/layout identique, drapeau désactivé par défaut, migration du lot A renumérotée
 * après les migrations de production (horodatage unique, postérieur à toutes les autres).
 * Données synthétiques uniquement.
 */
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import ts from "typescript"
import type { Role } from "@prisma/client"
import {
  getActiveNavHref, getNavItems, withAccountingNavItem, withBillingNavItems, withHrDocumentNavItems, withProspectionNavItem,
  withStockPurchasingNavItems, withSupplierIntakeNavItem, withWorksitePhotosNavItem, type NavItem,
} from "@/lib/navigation/nav-config"
import { getActiveNavCategoryId, groupNavItems } from "@/lib/navigation/nav-categories"
import { isStockPurchasingEnabled } from "@/lib/stock/stock-feature-flag"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")

type Flags = { accounting: boolean; billing: boolean; supplier: boolean; photos: boolean; hrOwn: boolean; hrManage: boolean; prospection: boolean }
/** Composition de production, à l'identique de Sidebar.tsx et MobileNav.tsx avant L1a. */
function production(role: Role, f: Flags): NavItem[] {
  return withProspectionNavItem(withHrDocumentNavItems(withWorksitePhotosNavItem(withSupplierIntakeNavItem(withBillingNavItems(withAccountingNavItem(getNavItems(role), f.accounting), f.billing), f.supplier), f.photos), f.hrOwn, f.hrManage), f.prospection)
}
/** Composition L1a : production enveloppée par le helper du lot A (même ordre que Sidebar.tsx et MobileNav.tsx). */
const withStock = (role: Role, f: Flags, stock: boolean) => withStockPurchasingNavItems(production(role, f), stock)

const ROLES: Role[] = ["SUPER_ADMIN", "ADMIN", "TEAM_LEADER", "EMPLOYEE", "CLIENT"]
const FLAG_SETS: Flags[] = Array.from({ length: 128 }, (_, n) => ({
  accounting: !!(n & 1), billing: !!(n & 2), supplier: !!(n & 4), photos: !!(n & 8), hrOwn: !!(n & 16), hrManage: !!(n & 32), prospection: !!(n & 64),
}))
const ALL_ON = FLAG_SETS[127]

describe("L1a : drapeau désactivé ⇒ navigation de production inchangée", () => {
  for (const role of ROLES) {
    it(`${role} × 128 combinaisons : mêmes entrées, même ordre, mêmes catégories`, () => {
      for (const flags of FLAG_SETS) {
        const before = production(role, flags)
        const after = withStock(role, flags, false)
        assert.deepEqual(after, before, `${role} ${JSON.stringify(flags)}`)
        assert.deepEqual(groupNavItems(after), groupNavItems(before))
        assert.equal(after.some((i) => i.href === "/stock" || i.href === "/achats"), false)
      }
    })
  }
  it("seule la valeur booléenne true rend visible (chaîne « true » refusée) ; nouvelle instance sans mutation", () => {
    const base = production("ADMIN", ALL_ON)
    const copy = [...base]
    assert.deepEqual(withStockPurchasingNavItems(base, "true" as unknown as boolean), base)
    assert.notEqual(withStockPurchasingNavItems(base, false), base)
    assert.deepEqual(base, copy)
  })
})

describe("L1a : drapeau activé ⇒ Stock et Achats dans « Chantiers & terrain »", () => {
  for (const role of ROLES) {
    it(`${role} × 128 combinaisons : partition sans perte ni doublon, jamais « Autres »`, () => {
      for (const flags of FLAG_SETS) {
        const composed = withStock(role, flags, true)
        const grouped = groupNavItems(composed)
        const regrouped = [...grouped.categories.flatMap((c) => c.items), ...grouped.footer]
        assert.equal(regrouped.length, composed.length)
        assert.deepEqual(new Set(regrouped), new Set(composed))
        assert.equal(new Set(regrouped.map((i) => i.href)).size, regrouped.length, "aucun doublon")
        assert.ok(grouped.categories.every((c) => c.id !== "autres"), `${role} ${JSON.stringify(flags)}`)
        assert.equal(composed.length, production(role, flags).length + 2)
        assert.deepEqual(grouped.footer.map((i) => i.href), ["/profil"].filter((h) => composed.some((i) => i.href === h)))
      }
    })
  }
  it("ADMIN et SUPER_ADMIN : ordre Véhicules, Stock, Achats, Logements ; idempotent", () => {
    for (const role of ["ADMIN", "SUPER_ADMIN"] as Role[]) {
      const terrain = groupNavItems(withStock(role, ALL_ON, true)).categories.find((c) => c.id === "terrain")!
      assert.deepEqual(terrain.items.map((i) => i.label), ["Chantiers", "Photos engins", "Véhicules", "Stock", "Achats", "Logements"], role)
      const once = withStock(role, ALL_ON, true)
      assert.deepEqual(withStockPurchasingNavItems(once, true), once)
    }
  })
  it("entrée active imbriquée : /achats/po1 ⇒ /achats, /stock/mouvements ⇒ /stock, catégorie « terrain »", () => {
    const items = withStock("ADMIN", ALL_ON, true)
    for (const [pathname, href] of [["/achats/po1", "/achats"], ["/stock/mouvements", "/stock"], ["/stock", "/stock"]] as const) {
      const active = getActiveNavHref(items, pathname)
      assert.equal(active, href)
      assert.equal(getActiveNavCategoryId(groupNavItems(items), active), "terrain")
    }
  })
})

/**
 * Occurrences de `name` dans le CODE, d'après l'arbre syntaxique TypeScript (TSX) : identifiants, chaînes, gabarits et texte
 * JSX. Les commentaires ne sont pas des nœuds : ils sont exclus, et le code qui les suit sur la même ligne reste analysé.
 */
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

describe("L1a : câblage serveur et drapeau désactivé par défaut", () => {
  it("témoins du contrôle « ne lit aucun drapeau » (arbre syntaxique) : commentaires admis, toute lecture refusée", () => {
    const F = "STOCK_PURCHASING_ENABLED"
    const commentaires = [
      `  /** Lot V2 : (drapeau ${F}) ; affichage seulement. */`, `  // ${F}`, `/* début\n * ${F}\n */`,
      `const a = 1 // ${F}`, `<aside>{/* ${F} */}</aside>`,
    ]
    for (const c of commentaires) assert.deepEqual(codeOccurrences(c, F), [], c)
    const lectures = [
      `const on = process.env.${F} === "true"`,
      `/* note */ const on = flags.${F}`,
      `/** doc */ const on = env["${F}"]`,
      `/* début\n fin */ const on = env["${F}"]`,
      `// ligne\nconst on = env[\`${F}\`]`,
      `const on = env[\`X_${"$"}{1}_${F}\`]`,
      `const { ${F}: on } = env`,
      `  visible: flags.${F}, // commentaire en fin de ligne`,
      `<p data-x="${F}" />`,
    ]
    for (const l of lectures) assert.ok(codeOccurrences(l, F).length >= 1, l)
  })
  it("le drapeau n'est actif que pour la valeur exacte « true »", () => {
    assert.equal(isStockPurchasingEnabled({}), false)
    for (const v of ["1", "TRUE", "yes", " true", ""]) assert.equal(isStockPurchasingEnabled({ STOCK_PURCHASING_ENABLED: v }), false, v)
    assert.equal(isStockPurchasingEnabled({ STOCK_PURCHASING_ENABLED: "true" }), true)
  })
  it("Sidebar et MobileNav enveloppent la composition de production par le helper, avec la visibilité serveur", () => {
    for (const file of ["src/components/layout/Sidebar.tsx", "src/components/layout/MobileNav.tsx"]) {
      const src = read(file)
      assert.match(src, /const navItems = withStockPurchasingNavItems\(withProspectionNavItem\(withHrDocumentNavItems\(/, file)
      assert.match(src, /user\.prospectionNavVisible === true\), user\.stockPurchasingNavVisible === true\)/, file)
      // v4 (preuve VM A r3) : le commentaire de documentation de Sidebar cite le nom du drapeau ; ce n'est pas une lecture.
      // Discriminant : process.env interdit partout (commentaires compris), nom du drapeau interdit dans tout nœud de code (arbre syntaxique),
      // helper serveur du drapeau jamais importé côté client.
      assert.doesNotMatch(src, /process\.env/, `${file} ne lit aucune variable d'environnement`)
      assert.deepEqual(codeOccurrences(src, "STOCK_PURCHASING_ENABLED"), [], `${file} ne lit aucun drapeau`)
      assert.doesNotMatch(src, /isStockPurchasingEnabled|stock-feature-flag/, `${file} n'importe pas le helper serveur du drapeau`)
    }
    const layout = read("src/app/(dashboard)/layout.tsx")
    assert.match(layout, /const stockPurchasingNavVisible = isStockPurchasingEnabled\(\) && \(role === "ADMIN" \|\| role === "SUPER_ADMIN"\) && !!companyId/)
    // L1b v5 (preuve VM B r4, 04-test-stock) : le lot B insère equipmentNavVisible dans le même objet ; la contiguïté textuelle
    // n'est plus exigée. Transmission vérifiée SÉMANTIQUEMENT (arbre syntaxique) : chaque visibilité exactement une fois en
    // propriété abrégée de l'objet `user`, lui-même transmis à Sidebar et Navbar ; ordre libre.
    const sf = ts.createSourceFile("layout.tsx", layout, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const objets: ts.ObjectLiteralExpression[] = []
    const chercher = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === "user" && n.initializer && ts.isObjectLiteralExpression(n.initializer)) objets.push(n.initializer)
      ts.forEachChild(n, chercher)
    }
    chercher(sf)
    assert.equal(objets.length, 1, "un seul objet user dans le layout")
    const abregees = objets[0].properties.filter(ts.isShorthandPropertyAssignment).map((p) => p.name.text)
    for (const nom of ["prospectionNavVisible", "stockPurchasingNavVisible", "companyLogo"]) assert.equal(abregees.filter((x) => x === nom).length, 1, nom)
    assert.match(layout, /<Sidebar user=\{user\} \/>/)
    assert.match(layout, /<Navbar user=\{user\} \/>/)
  })
})

describe("L1a : migration du lot A renumérotée après la production", () => {
  const LOT_A = "20261110120000_v2_lot_a_stock_purchasing"
  const dirs = readdirSync(join(ROOT, "prisma/migrations"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  // L1b (10/11/2026, modification signalée et tracée) : les migrations du lot B sont renumérotées APRÈS celle du lot A, sur
  // consigne. Elles forment la seule exception, en liste FERMÉE, à « postérieure à toutes les autres » ; tout autre écart
  // reste refusé. L'ordre A < B < garde est vérifié par tests/navigation/nav-equipment.test.ts.
  // 13/11/2026 (modification signalée) : la migration additive SPEC-INVOICE-IMPORT-001 est postérieure aux lots V2 ; elle rejoint
  // la liste FERMÉE des migrations admises après le lot A. Tout autre écart reste refusé.
  const LATER_V2_LOTS = new Set(["20261110130000_v2_lot_b_equipment_rental", "20261110140000_v2_lot_b_booking_overlap_guard", "20261113120000_invoice_import_bank_verification"])
  it("présente une seule fois, ancien nom absent, horodatage unique et postérieur à toutes les autres migrations (hors lot B, liste fermée)", () => {
    assert.ok(dirs.includes(LOT_A))
    assert.equal(dirs.some((d) => d.startsWith("20261104120000_v2_lot_a")), false, "ancien horodatage (collision avec prospect_opportunities) absent")
    const stamp = LOT_A.slice(0, 14)
    const others = dirs.filter((d) => d !== LOT_A)
    for (const d of others) assert.match(d, /^\d{14}_/, d)
    assert.equal(others.some((d) => d.startsWith(`${stamp}_`)), false, "horodatage unique")
    for (const d of others) if (!LATER_V2_LOTS.has(d)) assert.ok(d.slice(0, 14) < stamp, `${d} doit précéder le lot A`)
    for (const prod of ["20261104120000_prospect_opportunities", "20261106120000_v2_quote_recipient_purchase_order", "20261108130000_hr_private_space"]) {
      assert.ok(dirs.includes(prod), `migration de production ${prod} conservée`)
    }
  })
})
