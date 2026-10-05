import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import {
  applyEmployeeView,
  buildTeamOptions,
  classifyEmployeeFunction,
  computeEmployeeStats,
  countActiveEmployeeFilters,
  DEFAULT_EMPLOYEE_STATE,
  EMPTY_EMPLOYEE_FILTERS,
  NO_TEAM,
  toEmployeeViewItems,
  type EmployeeRow,
  type EmployeeViewItem,
  type EmployeeViewQuery,
} from "@/lib/employes/employes-view"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")

const NORD = { id: "t-nord", name: "Équipe Nord", color: "#123456" }
const SUD = { id: "t-sud", name: "Équipe Sud", color: null }

function emp(overrides: Partial<EmployeeViewItem> & { id: string }): EmployeeViewItem {
  return {
    firstName: overrides.id,
    lastName: "Test",
    jobTitle: null,
    phone: null,
    avatarUrl: null,
    active: true,
    leadsTeam: false,
    team: null,
    ...overrides,
  }
}

const DATA: EmployeeViewItem[] = [
  emp({ id: "chef-leader", firstName: "Paul", lastName: "Martin", jobTitle: "Électricien", leadsTeam: true, team: NORD }),
  emp({ id: "chef-title", firstName: "Hélène", lastName: "Durand", jobTitle: "Chef d'équipe", team: SUD }),
  emp({ id: "conducteur", firstName: "Marc", lastName: "Leroy", jobTitle: "Conducteur de travaux" }),
  emp({ id: "chauffeur", firstName: "Luc", lastName: "Petit", jobTitle: "Conducteur", team: NORD }),
  emp({ id: "tech", firstName: "Zoé", lastName: "Bernard", jobTitle: "Technicien monteur", team: NORD }),
  emp({ id: "monteur", firstName: "Ali", lastName: "Haddad", jobTitle: "Monteur", team: SUD }),
  emp({ id: "cariste", firstName: "Bruno", lastName: "Roux", jobTitle: "Cariste" }),
  emp({ id: "archived-tech", firstName: "Céline", lastName: "Morel", jobTitle: "Technicienne", active: false, team: SUD }),
  emp({ id: "archived-other", firstName: "Denis", lastName: "Faure", jobTitle: null, active: false }),
]

function run(partial: Partial<EmployeeViewQuery>) {
  return applyEmployeeView(DATA, {
    state: DEFAULT_EMPLOYEE_STATE,
    search: "",
    filters: EMPTY_EMPLOYEE_FILTERS,
    ...partial,
  })
}

const ids = (r: ReturnType<typeof run>) => r.groups.flatMap((g) => g.items.map((e) => e.id))

describe("Employés — Actifs / Archivés / Tous (drapeau active existant)", () => {
  it("défaut = Actifs : uniquement active=true", () => {
    assert.equal(DEFAULT_EMPLOYEE_STATE, "active")
    const r = run({})
    assert.equal(r.total, 7)
    assert.ok(!ids(r).includes("archived-tech"))
    assert.ok(!ids(r).includes("archived-other"))
  })

  it("Archivés = active=false uniquement", () => {
    assert.deepEqual(ids(run({ state: "archived" })).sort(), ["archived-other", "archived-tech"])
  })

  it("Tous = les deux", () => {
    assert.equal(run({ state: "all" }).total, DATA.length)
  })

  it("compteurs d'onglets réels", () => {
    assert.deepEqual(run({}).counts, { active: 7, archived: 2, all: 9 })
  })
})

describe("Employés — regroupement par fonction", () => {
  it("classification : chef (donnée structurée ou poste), conducteur de travaux, technicien/monteur, autres", () => {
    assert.equal(classifyEmployeeFunction({ jobTitle: "Électricien", leadsTeam: true }), "chef")
    assert.equal(classifyEmployeeFunction({ jobTitle: "Chef d'équipe", leadsTeam: false }), "chef")
    assert.equal(classifyEmployeeFunction({ jobTitle: "chef d’equipe", leadsTeam: false }), "chef")
    assert.equal(classifyEmployeeFunction({ jobTitle: "Chef equipe", leadsTeam: false }), "chef")
    assert.equal(classifyEmployeeFunction({ jobTitle: "Conducteur de travaux", leadsTeam: false }), "conducteur")
    assert.equal(classifyEmployeeFunction({ jobTitle: "Conducteur", leadsTeam: false }), "autre")
    assert.equal(classifyEmployeeFunction({ jobTitle: "Technicien monteur", leadsTeam: false }), "technicien")
    assert.equal(classifyEmployeeFunction({ jobTitle: "Technicienne", leadsTeam: false }), "technicien")
    assert.equal(classifyEmployeeFunction({ jobTitle: "Monteur", leadsTeam: false }), "technicien")
    assert.equal(classifyEmployeeFunction({ jobTitle: "Cariste", leadsTeam: false }), "autre")
    assert.equal(classifyEmployeeFunction({ jobTitle: null, leadsTeam: false }), "autre")
  })

  it("ordre des sections = priorité : chefs, conducteurs, techniciens, autres ; groupes vides omis", () => {
    const r = run({})
    assert.deepEqual(
      r.groups.map((g) => [g.fonction, g.items.map((e) => e.id)]),
      [
        ["chef", ["chef-title", "chef-leader"]],
        ["conducteur", ["conducteur"]],
        ["technicien", ["monteur", "tech"]],
        ["autre", ["cariste", "chauffeur"]],
      ]
    )
    const archived = run({ state: "archived" })
    assert.deepEqual(archived.groups.map((g) => g.fonction), ["technicien", "autre"])
  })

  it("indicateurs : actifs, archivés, et fonctions comptées parmi les actifs seulement", () => {
    assert.deepEqual(computeEmployeeStats(DATA), {
      active: 7,
      archived: 2,
      chefs: 2,
      techniciens: 2,
      conducteurs: 1,
    })
  })
})

describe("Employés — recherche", () => {
  it("nom / prénom, insensible à la casse et aux accents", () => {
    assert.deepEqual(ids(run({ search: "HELENE" })), ["chef-title"])
    assert.deepEqual(ids(run({ search: "zoe bernard" })), ["tech"])
  })

  it("fonction (poste et libellé de section)", () => {
    assert.deepEqual(ids(run({ search: "cariste" })), ["cariste"])
    assert.deepEqual(ids(run({ search: "conducteurs de travaux" })), ["conducteur"])
  })

  it("équipe", () => {
    assert.deepEqual(ids(run({ search: "equipe sud" })).sort(), ["chef-title", "monteur"])
    assert.deepEqual(ids(run({ state: "all", search: "equipe sud" })).sort(), ["archived-tech", "chef-title", "monteur"])
  })

  it("les compteurs d'onglets reflètent la recherche", () => {
    assert.deepEqual(run({ search: "equipe sud" }).counts, { active: 2, archived: 1, all: 3 })
  })
})

describe("Employés — filtres", () => {
  it("filtre fonction", () => {
    assert.deepEqual(ids(run({ filters: { fonction: "technicien", teamId: null } })), ["monteur", "tech"])
  })

  it("filtre équipe et « Sans équipe »", () => {
    assert.deepEqual(ids(run({ filters: { fonction: null, teamId: "t-nord" } })).sort(), ["chauffeur", "chef-leader", "tech"])
    assert.deepEqual(ids(run({ filters: { fonction: null, teamId: NO_TEAM } })).sort(), ["cariste", "conducteur"])
  })

  it("combinaison onglet + recherche + fonction + équipe", () => {
    // « tech » couvre aussi le libellé de fonction « Techniciens / Monteurs » (monteur inclus).
    assert.deepEqual(
      ids(run({ state: "all", search: "tech", filters: { fonction: "technicien", teamId: "t-sud" } })),
      ["monteur", "archived-tech"]
    )
    assert.deepEqual(
      ids(run({ state: "archived", search: "tech", filters: { fonction: "technicien", teamId: "t-sud" } })),
      ["archived-tech"]
    )
    assert.deepEqual(
      ids(run({ state: "all", search: "tech", filters: { fonction: "technicien", teamId: "t-nord" } })),
      ["tech"]
    )
  })

  it("reset des filtres → résultat par défaut", () => {
    assert.equal(countActiveEmployeeFilters({ fonction: "chef", teamId: "t-nord" }), 2)
    assert.equal(countActiveEmployeeFilters(EMPTY_EMPLOYEE_FILTERS), 0)
    assert.deepEqual(ids(run({ filters: EMPTY_EMPLOYEE_FILTERS })), ids(run({})))
  })

  it("options d'équipe dérivées des données autorisées, + « Sans équipe »", () => {
    assert.deepEqual(buildTeamOptions(DATA), [
      { id: "t-nord", label: "Équipe Nord" },
      { id: "t-sud", label: "Équipe Sud" },
      { id: NO_TEAM, label: "Sans équipe" },
    ])
  })
})

describe("Employés — tenant / exposition de données", () => {
  const row = (o: Partial<EmployeeRow> & { id: string }): EmployeeRow => ({
    companyId: "co-1",
    firstName: o.id,
    lastName: "X",
    jobTitle: null,
    phone: null,
    avatarUrl: null,
    active: true,
    user: { role: "EMPLOYEE" },
    teamMemberships: [],
    ledTeams: [],
    ...o,
  })

  it("projection : lignes et équipes d'un autre tenant ignorées", () => {
    const items = toEmployeeViewItems(
      [
        row({ id: "ok", teamMemberships: [{ team: { id: "t-foreign", name: "Étrangère", color: null, companyId: "co-2" } }, { team: { id: "t1", name: "Nord", color: null, companyId: "co-1" } }] }),
        row({ id: "foreign", companyId: "co-2" }),
        row({ id: "leader", ledTeams: [{ id: "t-evil", name: "Evil", color: null, companyId: "co-2" }] }),
      ],
      "co-1"
    )
    assert.deepEqual(items.map((i) => i.id), ["ok", "leader"])
    assert.equal(items[0].team?.id, "t1")
    assert.equal(items[1].team, null)
    assert.equal(items[1].leadsTeam, false)
    assert.ok(!JSON.stringify(items).includes("Evil"))
    assert.ok(!JSON.stringify(items).includes("Étrangère"))
  })

  it("chef d'équipe : équipe dirigée (tenant) ou rôle TEAM_LEADER", () => {
    const [a, b] = toEmployeeViewItems(
      [
        row({ id: "a", ledTeams: [{ id: "t1", name: "Nord", color: null, companyId: "co-1" }] }),
        row({ id: "b", user: { role: "TEAM_LEADER" } }),
      ],
      "co-1"
    )
    assert.equal(a.leadsTeam, true)
    assert.equal(a.team?.id, "t1")
    assert.equal(b.leadsTeam, true)
  })

  it("la projection n'expose ni email, ni userId, ni companyId", () => {
    const [item] = toEmployeeViewItems([row({ id: "a" })], "co-1")
    assert.deepEqual(Object.keys(item).sort(), [
      "active", "avatarUrl", "firstName", "id", "jobTitle", "lastName", "leadsTeam", "phone", "team",
    ])
  })

  it("page : companyId issu de la session, RBAC inchangé, aucun email sélectionné", () => {
    const src = read("src/app/(dashboard)/employes/page.tsx")
    assert.ok(src.includes('["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(session.user.role)'))
    assert.ok(src.includes("const companyId = session.user.companyId!"))
    assert.ok(src.includes("where: { companyId }"))
    assert.ok(src.includes("team: { companyId }"))
    assert.ok(src.includes("ledTeams: {") && src.includes("where: { active: true, companyId }"))
    assert.ok(!src.includes("email: true"))
    assert.ok(src.includes("toEmployeeViewItems(rows, companyId)"))
  })
})

describe("Employés — conservation des actions existantes", () => {
  it("le hook partagé appelle les server actions existantes, confirmation conservée avant suppression", () => {
    const hook = read("src/components/employes/useEmployeActions.ts")
    assert.ok(hook.includes('from "@/lib/actions/employe.actions"'))
    assert.ok(hook.includes("toggleEmployeActive(employeeId, !active)"))
    assert.ok(hook.includes("deleteEmploye(employeeId)"))
    assert.ok(/if \(!confirm\(/.test(hook))
  })

  it("fiche détail (boutons) et menu « ⋯ » (liste) utilisent le même hook", () => {
    assert.ok(read("src/components/employes/EmployeActions.tsx").includes("useEmployeActions(employeeId, active)"))
    const menu = read("src/components/employes/EmployeActionsMenu.tsx")
    assert.ok(menu.includes("useEmployeActions(employeeId, active)"))
    assert.ok(menu.includes("onSelect={toggleActive}"))
    assert.ok(menu.includes("onSelect={remove}"))
    assert.ok(menu.includes("aria-label={`Actions pour ${fullName}`}"))
  })

  it("les server actions conservent RBAC + scope companyId", () => {
    const actions = read("src/lib/actions/employe.actions.ts")
    assert.ok(actions.includes('["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(session.user.role)'))
    assert.ok(actions.includes("where: { id: employeeId, companyId: user.companyId! }"))
  })
})
