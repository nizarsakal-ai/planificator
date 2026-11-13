/**
 * L1b Planificator V2 (lot B reporté sur A v3) — entrée « Matériel » dans la navigation de PRODUCTION (V1).
 * Drapeau B désactivé ⇒ navigation strictement identique à la composition A v3 (tous rôles × drapeaux existants, Stock inclus).
 * Drapeau activé ⇒ une entrée dans « Chantiers & terrain », après Achats (ou Véhicules), jamais dans « Autres ».
 * Plus : câblage Sidebar/MobileNav/layout, drapeau désactivé par défaut, migrations du lot B renumérotées APRÈS le lot A
 * (A < B < garde), horodatages uniques. Données synthétiques uniquement.
 */
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import ts from "typescript"
import type { Role } from "@prisma/client"
import {
  getActiveNavHref, getNavItems, withAccountingNavItem, withBillingNavItems, withEquipmentNavItem, withHrDocumentNavItems,
  withProspectionNavItem, withStockPurchasingNavItems, withSupplierIntakeNavItem, withWorksitePhotosNavItem, type NavItem,
} from "@/lib/navigation/nav-config"
import { getActiveNavCategoryId, groupNavItems } from "@/lib/navigation/nav-categories"
import { isEquipmentRentalEnabled } from "@/lib/equipment/equipment-feature-flag"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")

type Flags = { accounting: boolean; billing: boolean; supplier: boolean; photos: boolean; hrOwn: boolean; hrManage: boolean; prospection: boolean; stock: boolean }
/** Composition A v3 (avant L1b), à l'identique de Sidebar.tsx et MobileNav.tsx de l'arbre ae379904. */
function aV3(role: Role, f: Flags): NavItem[] {
  return withStockPurchasingNavItems(withProspectionNavItem(withHrDocumentNavItems(withWorksitePhotosNavItem(withSupplierIntakeNavItem(withBillingNavItems(withAccountingNavItem(getNavItems(role), f.accounting), f.billing), f.supplier), f.photos), f.hrOwn, f.hrManage), f.prospection), f.stock)
}
/** Composition L1b : même chaîne, « Matériel » inséré entre documents RH et photos (même ordre que Sidebar.tsx/MobileNav.tsx). */
function l1b(role: Role, f: Flags, equipment: boolean): NavItem[] {
  return withStockPurchasingNavItems(withProspectionNavItem(withHrDocumentNavItems(withEquipmentNavItem(withWorksitePhotosNavItem(withSupplierIntakeNavItem(withBillingNavItems(withAccountingNavItem(getNavItems(role), f.accounting), f.billing), f.supplier), f.photos), equipment), f.hrOwn, f.hrManage), f.prospection), f.stock)
}
const ROLES: Role[] = ["SUPER_ADMIN", "ADMIN", "TEAM_LEADER", "EMPLOYEE", "CLIENT"]
const FLAG_SETS: Flags[] = Array.from({ length: 256 }, (_, n) => ({
  accounting: !!(n & 1), billing: !!(n & 2), supplier: !!(n & 4), photos: !!(n & 8), hrOwn: !!(n & 16), hrManage: !!(n & 32), prospection: !!(n & 64), stock: !!(n & 128),
}))
const ALL_ON = FLAG_SETS[255]

describe("L1b : drapeau désactivé ⇒ navigation A v3 inchangée", () => {
  for (const role of ROLES) {
    it(`${role} × 256 combinaisons : mêmes entrées, même ordre, mêmes catégories`, () => {
      for (const flags of FLAG_SETS) {
        const before = aV3(role, flags)
        const after = l1b(role, flags, false)
        assert.deepEqual(after, before, `${role} ${JSON.stringify(flags)}`)
        assert.deepEqual(groupNavItems(after), groupNavItems(before))
        assert.equal(after.some((i) => i.href === "/materiel"), false)
      }
    })
  }
  it("seule la valeur booléenne true rend visible ; nouvelle instance sans mutation", () => {
    const base = aV3("ADMIN", ALL_ON)
    const copy = [...base]
    assert.deepEqual(withEquipmentNavItem(base, "true" as unknown as boolean), base)
    assert.notEqual(withEquipmentNavItem(base, false), base)
    assert.deepEqual(base, copy)
  })
})

describe("L1b : drapeau activé ⇒ « Matériel » dans « Chantiers & terrain »", () => {
  for (const role of ROLES) {
    it(`${role} × 256 combinaisons : partition sans perte ni doublon, jamais « Autres »`, () => {
      for (const flags of FLAG_SETS) {
        const composed = l1b(role, flags, true)
        const grouped = groupNavItems(composed)
        const regrouped = [...grouped.categories.flatMap((c) => c.items), ...grouped.footer]
        assert.equal(regrouped.length, composed.length)
        assert.deepEqual(new Set(regrouped), new Set(composed))
        assert.equal(new Set(regrouped.map((i) => i.href)).size, regrouped.length, "aucun doublon")
        assert.ok(grouped.categories.every((c) => c.id !== "autres"), `${role} ${JSON.stringify(flags)}`)
        assert.equal(composed.length, aV3(role, flags).length + 1)
      }
    })
  }
  it("ADMIN et SUPER_ADMIN : Véhicules, Stock, Achats, Matériel, Logements ; sans le lot A : Véhicules, Matériel, Logements ; idempotent", () => {
    for (const role of ["ADMIN", "SUPER_ADMIN"] as Role[]) {
      const terrain = (f: Flags) => groupNavItems(l1b(role, f, true)).categories.find((c) => c.id === "terrain")!.items.map((i) => i.label)
      assert.deepEqual(terrain(ALL_ON), ["Chantiers", "Photos engins", "Véhicules", "Stock", "Achats", "Matériel", "Logements"], role)
      assert.deepEqual(terrain({ ...ALL_ON, stock: false }), ["Chantiers", "Photos engins", "Véhicules", "Matériel", "Logements"], role)
      const once = l1b(role, ALL_ON, true)
      assert.deepEqual(withEquipmentNavItem(once, true), once)
    }
  })
  it("entrée active imbriquée : /materiel/eq1 et /materiel/locations ⇒ /materiel, catégorie « terrain »", () => {
    const items = l1b("ADMIN", ALL_ON, true)
    for (const pathname of ["/materiel", "/materiel/eq1", "/materiel/locations"]) {
      const active = getActiveNavHref(items, pathname)
      assert.equal(active, "/materiel")
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

describe("L1b : câblage serveur et drapeau désactivé par défaut", () => {
  it("témoins du contrôle « ne lit aucun drapeau » (arbre syntaxique) : commentaires admis, toute lecture refusée", () => {
    const F = "EQUIPMENT_RENTAL_ENABLED"
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
  it("le drapeau n'est actif que pour la valeur exacte « true », indépendamment du lot A", () => {
    assert.equal(isEquipmentRentalEnabled({}), false)
    for (const v of ["1", "TRUE", "yes", " true", ""]) assert.equal(isEquipmentRentalEnabled({ EQUIPMENT_RENTAL_ENABLED: v }), false, v)
    assert.equal(isEquipmentRentalEnabled({ STOCK_PURCHASING_ENABLED: "true" }), false)
    assert.equal(isEquipmentRentalEnabled({ EQUIPMENT_RENTAL_ENABLED: "true" }), true)
  })
  it("Sidebar et MobileNav insèrent le helper entre documents RH et photos, avec la visibilité serveur", () => {
    for (const file of ["src/components/layout/Sidebar.tsx", "src/components/layout/MobileNav.tsx"]) {
      const src = read(file)
      assert.match(src, /withHrDocumentNavItems\(withEquipmentNavItem\(withWorksitePhotosNavItem\(withSupplierIntakeNavItem\(/, file)
      assert.match(src, /user\.worksitePhotosNavVisible === true\), user\.equipmentNavVisible === true\), user\.hrDocumentsNavVisible === true,/, file)
      // v4 (défaut constaté en VM sur le test jumeau du lot A) : le commentaire de Sidebar cite le nom du drapeau ; ce n'est
      // pas une lecture. Discriminant : process.env interdit partout, nom du drapeau interdit dans tout nœud de code (arbre syntaxique), helper
      // serveur du drapeau jamais importé côté client.
      assert.doesNotMatch(src, /process\.env/, `${file} ne lit aucune variable d'environnement`)
      assert.deepEqual(codeOccurrences(src, "EQUIPMENT_RENTAL_ENABLED"), [], `${file} ne lit aucun drapeau`)
      assert.doesNotMatch(src, /isEquipmentRentalEnabled|equipment-feature-flag/, `${file} n'importe pas le helper serveur du drapeau`)
    }
    const layout = read("src/app/(dashboard)/layout.tsx")
    assert.match(layout, /const equipmentNavVisible = isEquipmentRentalEnabled\(\) && \(role === "ADMIN" \|\| role === "SUPER_ADMIN"\) && !!companyId/)
    assert.match(layout, /stockPurchasingNavVisible, equipmentNavVisible, companyLogo/)
  })
})

describe("L1b : migrations du lot B renumérotées après le lot A", () => {
  const A = "20261110120000_v2_lot_a_stock_purchasing"
  const B = "20261110130000_v2_lot_b_equipment_rental"
  const GUARD = "20261110140000_v2_lot_b_booking_overlap_guard"
  const dirs = readdirSync(join(ROOT, "prisma/migrations"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  it("A < B < garde, chacune présente une fois, anciens noms absents, horodatages uniques, B et garde après toute autre migration", () => {
    for (const d of [A, B, GUARD]) assert.equal(dirs.filter((x) => x === d).length, 1, d)
    assert.ok(A.slice(0, 14) < B.slice(0, 14) && B.slice(0, 14) < GUARD.slice(0, 14))
    assert.equal(dirs.some((d) => d.startsWith("20261104130000_v2_lot_b") || d.startsWith("20261106130000_v2_lot_b")), false, "anciens horodatages absents")
    for (const stamp of [B, GUARD].map((d) => d.slice(0, 14))) assert.equal(dirs.filter((d) => d.startsWith(`${stamp}_`)).length, 1, `horodatage ${stamp} unique`)
    // 13/11/2026 (modification signalée) : liste FERMÉE des migrations postérieures au lot B (SPEC-INVOICE-IMPORT-001, additive).
    const LATER = new Set(["20261113120000_invoice_import_bank_verification"])
    for (const d of dirs.filter((x) => x !== B && x !== GUARD && !LATER.has(x))) assert.ok(d.slice(0, 14) < B.slice(0, 14), `${d} doit précéder le lot B`)
    for (const d of LATER) assert.ok(dirs.includes(d) && d.slice(0, 14) > GUARD.slice(0, 14), `${d} doit suivre la garde du lot B`)
  })
  it("la garde de chevauchement porte sur les réservations actives et verrouille l'équipement (contenu repris de 74cdfdfc)", () => {
    const sql = read(`prisma/migrations/${GUARD}/migration.sql`)
    assert.match(sql, /CREATE TRIGGER equipment_bookings_no_overlap/)
    assert.match(sql, /FOR UPDATE/)
    assert.match(sql, /'RESERVED', 'CHECKED_OUT'/)
  })
})
