/**
 * Navigation par catégories — partition SANS perte ni doublon après la composition existante (rôles × drapeaux),
 * cartographie validée, catégorie de repli, entrée active imbriquée, réducteur d'ouverture (rouverture par navigation).
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Role } from "@prisma/client"
import { Camera } from "lucide-react"
import {
  getActiveNavHref, getNavItems, withAccountingNavItem, withBillingNavItems, withSupplierIntakeNavItem, withWorksitePhotosNavItem, type NavItem,
} from "@/lib/navigation/nav-config"
import { getActiveNavCategoryId, groupNavItems, navCategoryOf, type NavCategoryId } from "@/lib/navigation/nav-categories"
import { initialNavOpenState, reduceNavOpenState } from "@/components/layout/NavCategories"

type Flags = { accounting: boolean; billing: boolean; supplier: boolean; photos: boolean }
/** Même composition que Sidebar.tsx et MobileNav.tsx (ordre des helpers inclus). */
function compose(role: Role, f: Flags): NavItem[] {
  return withWorksitePhotosNavItem(withSupplierIntakeNavItem(withBillingNavItems(withAccountingNavItem(getNavItems(role), f.accounting), f.billing), f.supplier), f.photos)
}
const ROLES: Role[] = ["SUPER_ADMIN", "ADMIN", "TEAM_LEADER", "EMPLOYEE", "CLIENT"]
const FLAG_SETS: Flags[] = Array.from({ length: 16 }, (_, n) => ({ accounting: !!(n & 1), billing: !!(n & 2), supplier: !!(n & 4), photos: !!(n & 8) }))
const ALL_ON: Flags = { accounting: true, billing: true, supplier: true, photos: true }
const shape = (role: Role, f: Flags) => {
  const g = groupNavItems(compose(role, f))
  return Object.fromEntries([...g.categories.map((c) => [c.id, c.items.map((i) => i.label)] as const), ["footer", g.footer.map((i) => i.label)]])
}

describe("partition après composition : aucune entrée ajoutée, perdue ni dupliquée", () => {
  for (const role of ROLES) {
    it(`${role} × 16 combinaisons de drapeaux`, () => {
      for (const flags of FLAG_SETS) {
        const composed = compose(role, flags)
        const grouped = groupNavItems(composed)
        const regrouped = [...grouped.categories.flatMap((c) => c.items), ...grouped.footer]
        assert.equal(regrouped.length, composed.length, `${role} ${JSON.stringify(flags)}`)
        assert.deepEqual(new Set(regrouped), new Set(composed), "mêmes objets (libellés, href, icônes, badges conservés)")
        assert.equal(new Set(regrouped.map((i) => i.href)).size, regrouped.length, "aucun doublon")
        assert.ok(grouped.categories.every((c) => c.items.length > 0), "aucune catégorie vide")
        assert.ok(grouped.categories.every((c) => c.id !== "autres"), "toutes les entrées actuelles sont cartographiées")
      }
    })
  }
  it("CLIENT (le layout ne calcule aucune visibilité pour lui et le redirige) : aucune catégorie, aucun pied", () => {
    assert.deepEqual(groupNavItems(compose("CLIENT", { accounting: false, billing: false, supplier: false, photos: false })), { categories: [], footer: [] })
  })
  it("entrée inconnue ⇒ « Autres » (jamais perdue), ordre d'origine conservé ; catégories dans l'ordre fixe", () => {
    const extra: NavItem[] = [{ label: "Nouveau module", href: "/nouveau", icon: Camera, badge: "Bientôt" }, { label: "Autre", href: "/autre", icon: Camera }]
    const grouped = groupNavItems([...extra, ...compose("ADMIN", ALL_ON)])
    const autres = grouped.categories[grouped.categories.length - 1]
    assert.equal(autres.id, "autres")
    assert.deepEqual(autres.items, extra)
    assert.equal(navCategoryOf("/inconnu"), "autres")
    assert.equal(navCategoryOf("/profil"), null)
  })
})

describe("cartographie validée", () => {
  // NB : les helpers de drapeaux ne connaissent pas les rôles (la visibilité est calculée par le serveur) : « tous drapeaux »
  // décrit la composition pure ; le regroupement place chaque entrée composée, quelle que soit son origine.
  it("SUPER_ADMIN, tous drapeaux : catégories, ordre et pied", () => {
    assert.deepEqual(shape("SUPER_ADMIN", ALL_ON), {
      pilotage: ["Dashboard", "Rapports"],
      terrain: ["Chantiers", "Photos engins", "Véhicules", "Logements"],
      planning: ["Planning", "Calendrier", "Gantt", "Personnel"],
      rh: ["Employés", "Équipes", "Absences", "Pointages", "Notes de frais"],
      commercial: ["Clients", "Consultations", "Devis", "Bibliothèque"],
      finance: ["Factures", "Comptabilité", "Factures fournisseurs & OCR"],
      administration: ["Administration", "Paramètres"],
      footer: ["Mon profil"],
    })
  })
  it("ADMIN, tous drapeaux : Comptabilité dans Finance, pas d'Administration entreprises", () => {
    const s = shape("ADMIN", ALL_ON)
    assert.deepEqual(s.finance, ["Factures", "Comptabilité", "Factures fournisseurs & OCR"])
    assert.deepEqual(s.administration, ["Paramètres"])
  })
  it("TEAM_LEADER : Mes chantiers → Terrain, Mon planning → Planning, Mon équipe et entrées personnelles → RH", () => {
    assert.deepEqual(shape("TEAM_LEADER", ALL_ON), {
      pilotage: ["Dashboard"],
      terrain: ["Mes chantiers", "Photos engins"],
      planning: ["Mon planning", "Calendrier", "Gantt", "Personnel"],
      rh: ["Mon équipe", "Absences équipe", "Mes absences", "Pointages équipe", "Mon pointage", "Notes de frais"],
      finance: ["Factures fournisseurs & OCR"],
      footer: ["Mon profil"],
    })
  })
  it("EMPLOYEE : seulement ses entrées, Photos engins si le drapeau serveur l'ajoute", () => {
    assert.deepEqual(shape("EMPLOYEE", ALL_ON), {
      pilotage: ["Dashboard"], terrain: ["Mes chantiers", "Photos engins"], planning: ["Mon planning"],
      rh: ["Mes absences", "Pointage", "Notes de frais"], finance: ["Factures fournisseurs & OCR"], footer: ["Mon profil"],
    })
    assert.deepEqual(shape("EMPLOYEE", { ...ALL_ON, photos: false }).terrain, ["Mes chantiers"])
  })
  it("drapeaux absents ⇒ entrées absentes et catégories vides omises (aucun lien masqué rendu visible)", () => {
    const off = { accounting: false, billing: false, supplier: false, photos: false }
    const s = shape("SUPER_ADMIN", off)
    assert.deepEqual(s.finance, ["Factures"])
    assert.deepEqual(s.commercial, ["Clients", "Consultations", "Bibliothèque"])
    assert.deepEqual(s.terrain, ["Chantiers", "Véhicules", "Logements"])
    for (const role of ROLES) {
      const hrefs = groupNavItems(compose(role, off)).categories.flatMap((c) => c.items.map((i) => i.href))
      for (const hidden of ["/comptabilite", "/devis", "/factures-fournisseurs", "/photos-engins"]) assert.equal(hrefs.includes(hidden), false, `${role} ${hidden}`)
    }
  })
  it("Photos engins visible pour tous les rôles internes quand le drapeau est actif", () => {
    for (const role of ["SUPER_ADMIN", "ADMIN", "TEAM_LEADER", "EMPLOYEE"] as Role[]) {
      const terrain = groupNavItems(compose(role, ALL_ON)).categories.find((c) => c.id === "terrain")!
      assert.ok(terrain.items.some((i) => i.href === "/photos-engins"), role)
    }
  })
})

describe("catégorie active (règle d'activation existante : la plus spécifique)", () => {
  const cases: Array<[Role, string, string | null, NavCategoryId | null]> = [
    ["SUPER_ADMIN", "/chantiers/abc/documents", "/chantiers", "terrain"],
    ["SUPER_ADMIN", "/photos-engins", "/photos-engins", "terrain"],
    ["SUPER_ADMIN", "/planning/gantt/2026", "/planning/gantt", "planning"],
    ["SUPER_ADMIN", "/planning", "/planning", "planning"],
    ["SUPER_ADMIN", "/factures-fournisseurs/42", "/factures-fournisseurs", "finance"],
    ["SUPER_ADMIN", "/super-admin/entreprises/x", "/super-admin/entreprises", "administration"],
    ["SUPER_ADMIN", "/profil", "/profil", null],
    ["SUPER_ADMIN", "/dashboard/x", null, null],
    ["TEAM_LEADER", "/planning/equipe", "/planning/equipe", "rh"],
    ["TEAM_LEADER", "/pointage", "/pointage", "rh"],
    ["TEAM_LEADER", "/pointages/12", "/pointages", "rh"],
    ["EMPLOYEE", "/planning/moi", "/planning/moi", "planning"],
    ["EMPLOYEE", "/chantiers/1", "/chantiers", "terrain"],
  ]
  for (const [role, pathname, href, category] of cases) {
    it(`${role} ${pathname} ⇒ ${href ?? "aucun"} / ${category ?? "aucune"}`, () => {
      const items = compose(role, ALL_ON)
      const activeHref = getActiveNavHref(items, pathname)
      assert.equal(activeHref, href)
      assert.equal(getActiveNavCategoryId(groupNavItems(items), activeHref), category)
    })
  }
})

describe("ouverture des catégories : rouverture à chaque navigation, repli manuel respecté entre deux", () => {
  it("active ouverte au rendu ; repliée manuellement ; navigation vers une AUTRE page de détail du même parent ⇒ rouverte", () => {
    let state = initialNavOpenState("/chantiers/a", "terrain")
    assert.deepEqual([...state.open], ["terrain"])
    state = reduceNavOpenState(state, { type: "toggle", id: "terrain" })
    assert.deepEqual([...state.open], [])
    state = reduceNavOpenState(state, { type: "navigate", navigationKey: "/chantiers/a", activeCategoryId: "terrain" })
    assert.deepEqual([...state.open], [], "même clé (rendu sans navigation) : le repli manuel est respecté")
    state = reduceNavOpenState(state, { type: "navigate", navigationKey: "/chantiers/b", activeCategoryId: "terrain" })
    assert.deepEqual([...state.open], ["terrain"], "même entrée active (/chantiers) mais nouvelle navigation ⇒ rouverte")
  })
  it("même route mais NOUVELLE catégorie active (props / drapeaux actualisés) ⇒ ouverte ; repli manuel ensuite respecté", () => {
    let state = initialNavOpenState("/x", null)
    state = reduceNavOpenState(state, { type: "navigate", navigationKey: "/x", activeCategoryId: "finance" })
    assert.deepEqual([...state.open], ["finance"])
    state = reduceNavOpenState(state, { type: "toggle", id: "finance" })
    state = reduceNavOpenState(state, { type: "navigate", navigationKey: "/x", activeCategoryId: "finance" })
    assert.deepEqual([...state.open], [], "ni route ni catégorie active changées : repli conservé")
  })
  it("les autres catégories gardent leur état ; une catégorie peut être rouverte puis repliée ; aucune active ⇒ rien d'ajouté", () => {
    let state = initialNavOpenState("/planning", "planning")
    state = reduceNavOpenState(state, { type: "toggle", id: "finance" })
    state = reduceNavOpenState(state, { type: "navigate", navigationKey: "/chantiers", activeCategoryId: "terrain" })
    assert.deepEqual([...state.open].sort(), ["finance", "planning", "terrain"])
    state = reduceNavOpenState(state, { type: "toggle", id: "planning" })
    state = reduceNavOpenState(state, { type: "navigate", navigationKey: "/profil", activeCategoryId: null })
    assert.deepEqual([...state.open].sort(), ["finance", "terrain"])
  })
})
