/**
 * PR1 navigation — parité stricte avec les définitions historiques de Sidebar.tsx / MobileNav.tsx.
 * La référence GOLDEN est extraite mécaniquement des deux fichiers sur main @ 059755e
 * (identiques entre eux). Toute modification de libellé, href, icône, ordre ou visibilité
 * par rôle fait échouer ce test.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import * as lucide from "lucide-react"
import { getNavItems, isNavItemActive, ROLE_LABELS } from "@/lib/navigation/nav-config"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")

type Golden = [label: string, href: string, icon: keyof typeof lucide][]

const GOLDEN: Record<"SUPER_ADMIN" | "ADMIN" | "TEAM_LEADER" | "EMPLOYEE", Golden> = {
  SUPER_ADMIN: [
    ["Dashboard", "/dashboard", "LayoutDashboard"],
    ["Administration", "/super-admin/entreprises", "Building2"],
    ["Employés", "/employes", "Users"],
    ["Équipes", "/equipes", "Layers"],
    ["Véhicules", "/vehicules", "Truck"],
    ["Clients", "/clients", "UserCheck"],
    ["Chantiers", "/chantiers", "HardHat"],
    ["Consultations", "/consultations", "Mail"],
    ["Logements", "/logements", "BedDouble"],
    ["Bibliothèque", "/articles", "Library"],
    ["Factures", "/factures", "FileText"],
    ["Planning", "/planning", "Calendar"],
    ["Gantt", "/planning/gantt", "GanttChart"],
    ["Calendrier", "/planning/calendrier", "CalendarDays"],
    ["Personnel", "/planning/personnel", "Users"],
    ["Absences", "/absences", "CalendarOff"],
    ["Notes de frais", "/notes-de-frais", "Receipt"],
    ["Pointages", "/pointages", "MapPin"],
    ["Rapports", "/rapports", "ClipboardList"],
    ["Mon profil", "/profil", "User"],
    ["Paramètres", "/parametres", "Settings"],
  ],
  ADMIN: [
    ["Dashboard", "/dashboard", "LayoutDashboard"],
    ["Employés", "/employes", "Users"],
    ["Équipes", "/equipes", "Layers"],
    ["Véhicules", "/vehicules", "Truck"],
    ["Clients", "/clients", "UserCheck"],
    ["Chantiers", "/chantiers", "HardHat"],
    ["Consultations", "/consultations", "Mail"],
    ["Logements", "/logements", "BedDouble"],
    ["Bibliothèque", "/articles", "Library"],
    ["Factures", "/factures", "FileText"],
    ["Planning", "/planning", "Calendar"],
    ["Gantt", "/planning/gantt", "GanttChart"],
    ["Calendrier", "/planning/calendrier", "CalendarDays"],
    ["Personnel", "/planning/personnel", "Users"],
    ["Absences", "/absences", "CalendarOff"],
    ["Notes de frais", "/notes-de-frais", "Receipt"],
    ["Pointages", "/pointages", "MapPin"],
    ["Rapports", "/rapports", "ClipboardList"],
    ["Mon profil", "/profil", "User"],
    ["Paramètres", "/parametres", "Settings"],
  ],
  TEAM_LEADER: [
    ["Dashboard", "/dashboard", "LayoutDashboard"],
    ["Mon équipe", "/planning/equipe", "ClipboardList"],
    ["Mes chantiers", "/chantiers", "HardHat"],
    ["Mon planning", "/planning/moi", "Calendar"],
    ["Calendrier", "/planning/calendrier", "CalendarDays"],
    ["Personnel", "/planning/personnel", "Users"],
    ["Gantt", "/planning/gantt", "GanttChart"],
    ["Absences équipe", "/absences", "CalendarOff"],
    ["Pointages équipe", "/pointages", "MapPin"],
    ["Mes absences", "/mes-absences", "CalendarOff"],
    ["Notes de frais", "/mes-notes-de-frais", "Receipt"],
    ["Mon pointage", "/pointage", "MapPin"],
    ["Mon profil", "/profil", "User"],
  ],
  EMPLOYEE: [
    ["Dashboard", "/dashboard", "LayoutDashboard"],
    ["Mon planning", "/planning/moi", "Calendar"],
    ["Mes chantiers", "/chantiers", "HardHat"],
    ["Mes absences", "/mes-absences", "CalendarOff"],
    ["Notes de frais", "/mes-notes-de-frais", "Receipt"],
    ["Pointage", "/pointage", "MapPin"],
    ["Mon profil", "/profil", "User"],
  ],
}

const ROLES = Object.keys(GOLDEN) as (keyof typeof GOLDEN)[]

describe("nav-config — parité stricte par rôle", () => {
  for (const role of ROLES) {
    it(`${role} : nombre, libellés, href, icônes et ordre identiques`, () => {
      const items = getNavItems(role)
      const expected = GOLDEN[role]
      assert.equal(items.length, expected.length)
      assert.deepEqual(
        items.map((i) => [i.label, i.href]),
        expected.map(([label, href]) => [label, href])
      )
      items.forEach((item, idx) => {
        const iconName = expected[idx][2]
        assert.equal(item.icon, lucide[iconName], `${role} #${idx} ${item.label} → icône ${iconName}`)
        assert.equal(item.badge, undefined)
      })
    })
  }

  it("nombre d'entrées par rôle verrouillé (21 / 20 / 13 / 7)", () => {
    assert.deepEqual(
      ROLES.map((r) => [r, getNavItems(r).length]),
      [["SUPER_ADMIN", 21], ["ADMIN", 20], ["TEAM_LEADER", 13], ["EMPLOYEE", 7]]
    )
  })

  it("CLIENT et rôle inconnu → aucune entrée", () => {
    assert.deepEqual(getNavItems("CLIENT"), [])
    assert.deepEqual(getNavItems("UNKNOWN" as never), [])
  })

  it("aucune nouvelle route visible : l'union des href est exactement celle de la référence", () => {
    const actual = new Set(ROLES.flatMap((r) => getNavItems(r).map((i) => i.href)))
    const expected = new Set(ROLES.flatMap((r) => GOLDEN[r].map(([, href]) => href)))
    assert.deepEqual([...actual].sort(), [...expected].sort())
  })

  it("visibilité par rôle : aucune route d'un rôle n'apparaît pour un autre au-delà de la référence", () => {
    for (const role of ROLES) {
      assert.deepEqual(
        new Set(getNavItems(role).map((i) => i.href)),
        new Set(GOLDEN[role].map(([, href]) => href))
      )
    }
    assert.ok(!getNavItems("ADMIN").some((i) => i.href.startsWith("/super-admin")))
    assert.ok(!getNavItems("TEAM_LEADER").some((i) => ["/employes", "/equipes", "/clients", "/rapports", "/notes-de-frais"].includes(i.href)))
  })

  it("chaque appel renvoie une copie (pas de mutation partagée)", () => {
    const a = getNavItems("ADMIN")
    a.pop()
    assert.equal(getNavItems("ADMIN").length, 20)
  })
})

describe("nav-config — règle de lien actif identique à l'historique (collisions conservées)", () => {
  const legacy = (href: string, p: string) => (href === "/dashboard" ? p === "/dashboard" : p.startsWith(href))
  const PATHS = [
    "/", "/dashboard", "/dashboard/x", "/planning", "/planning/gantt", "/planning/calendrier",
    "/planning/personnel", "/planning/moi", "/planning/equipe", "/pointages", "/pointage",
    "/employes", "/employes/abc", "/chantiers/xyz", "/rapports/mensuel", "/mes-absences",
    "/absences", "/notes-de-frais", "/mes-notes-de-frais", "/profil", "/super-admin/entreprises",
  ]

  it("équivalence exhaustive avec l'ancienne règle pour tous les rôles et chemins", () => {
    for (const role of ROLES) {
      for (const item of getNavItems(role)) {
        for (const p of PATHS) assert.equal(isNavItemActive(item.href, p), legacy(item.href, p), `${role} ${item.href} @ ${p}`)
      }
    }
  })

  it("Dashboard : correspondance exacte uniquement", () => {
    assert.equal(isNavItemActive("/dashboard", "/dashboard"), true)
    assert.equal(isNavItemActive("/dashboard", "/dashboard/x"), false)
  })

  it("collisions connues CONSERVÉES en PR1 (corrigées en PR2)", () => {
    const activeLabels = (role: keyof typeof GOLDEN, p: string) =>
      getNavItems(role).filter((i) => isNavItemActive(i.href, p)).map((i) => i.label)
    assert.deepEqual(activeLabels("ADMIN", "/planning/gantt"), ["Planning", "Gantt"])
    assert.deepEqual(activeLabels("SUPER_ADMIN", "/planning/personnel"), ["Planning", "Personnel"])
    assert.deepEqual(activeLabels("TEAM_LEADER", "/pointages"), ["Pointages équipe", "Mon pointage"])
  })
})

describe("nav-config — source unique Sidebar / MobileNav", () => {
  for (const file of ["src/components/layout/Sidebar.tsx", "src/components/layout/MobileNav.tsx"]) {
    it(`${file} consomme la configuration centrale, sans liste ni règle locale`, () => {
      const src = read(file)
      assert.match(src, /from "@\/lib\/navigation\/nav-config"/)
      assert.match(src, /getNavItems\(user\.role\)/)
      assert.match(src, /isNavItemActive\(item\.href, pathname\)/)
      assert.match(src, /ROLE_LABELS\[user\.role\]/)
      assert.doesNotMatch(src, /function getNavItems/)
      assert.doesNotMatch(src, /startsWith\(/)
      assert.doesNotMatch(src, /href:\s*"\//, "aucune entrée de menu ne doit être définie localement")
      assert.doesNotMatch(src, /const roleLabel/)
    })
  }

  it("le logo Planificator (PR #64) est conservé dans les deux composants", () => {
    assert.match(read("src/components/layout/Sidebar.tsx"), /<PlanificatorLogo subtitle="Planning d'équipes" \/>/)
    assert.match(read("src/components/layout/MobileNav.tsx"), /<PlanificatorLogo \/>/)
  })
})

describe("nav-config — libellés de rôle inchangés", () => {
  it("ROLE_LABELS identique aux anciennes constantes locales", () => {
    assert.deepEqual(ROLE_LABELS, {
      SUPER_ADMIN: "Super Admin",
      ADMIN: "Administrateur",
      TEAM_LEADER: "Chef d'équipe",
      EMPLOYEE: "Employé",
      CLIENT: "Client",
    })
  })
})
