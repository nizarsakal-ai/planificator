import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  applyChantierView,
  buildChantierSetKey,
  buildClientOptions,
  buildPersonnelIndex,
  countActiveComplementaryFilters,
  DEFAULT_SORT,
  DEFAULT_STATE_FILTER,
  EMPTY_COMPLEMENTARY_FILTERS,
  matchesSearch,
  matchesState,
  shouldShowStatusBadge,
  type ChantierViewQuery,
  type EmployeeAssignmentRow,
  type FilterableChantier,
} from "@/lib/chantiers/chantiers-view-filters"

function chantier(overrides: Partial<FilterableChantier> & { id: string }): FilterableChantier {
  return {
    name: overrides.id,
    address: null,
    status: "IN_PROGRESS",
    startDate: null,
    endDate: null,
    clientId: "client-a",
    client: { name: "Client A" },
    _count: { assignments: 1 },
    employeeIds: [],
    ...overrides,
  }
}

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

const DATA: FilterableChantier[] = [
  chantier({
    id: "active-lauralu",
    name: "Rénovation Lauralu",
    status: "IN_PROGRESS",
    address: "12 rue de la Paix, 75002 Paris",
    clientId: "c-lauralu",
    client: { name: "Lauralu SAS" },
    startDate: d("2026-09-20"),
    endDate: d("2026-10-20"),
    employeeIds: ["emp-x", "emp-y"],
  }),
  chantier({
    id: "extended-dupont",
    name: "Extension Dupont",
    status: "EXTENDED",
    address: "3 avenue Foch, 69006 Lyon",
    clientId: "c-dupont",
    client: { name: "Dupont" },
    startDate: d("2026-08-01"),
    endDate: d("2026-10-10"),
    employeeIds: ["emp-y"],
  }),
  chantier({
    id: "planned-lauralu",
    name: "Bureaux Lauralu",
    status: "PLANNED",
    address: "8 bd Haussmann, 75009 Paris",
    clientId: "c-lauralu",
    client: { name: "Lauralu SAS" },
    startDate: d("2026-11-03"),
    endDate: d("2026-11-30"),
    _count: { assignments: 2 },
    employeeIds: ["emp-x"],
  }),
  chantier({
    id: "planned-unassigned",
    name: "Atelier Chénôve",
    status: "PLANNED",
    address: "1 place Centrale, 21300 Chenôve",
    clientId: "c-dupont",
    client: { name: "Dupont" },
    startDate: d("2026-12-01"),
    endDate: null,
    _count: { assignments: 0 },
  }),
  chantier({
    id: "delayed",
    name: "Zinguerie Martin",
    status: "DELAYED",
    clientId: "c-martin",
    client: { name: "Martin" },
    startDate: null,
    endDate: null,
    _count: { assignments: 0 },
  }),
  chantier({
    id: "completed-lauralu",
    name: "Ancien Lauralu",
    status: "COMPLETED",
    address: "40 rue de Rivoli, 75004 Paris",
    clientId: "c-lauralu",
    client: { name: "Lauralu SAS" },
    startDate: d("2025-01-10"),
    endDate: d("2025-02-15"),
    employeeIds: ["emp-x"],
  }),
  chantier({
    id: "archived-old",
    name: "Archive 2024",
    status: "ARCHIVED",
    clientId: "c-dupont",
    client: { name: "Dupont" },
    startDate: d("2024-03-01"),
    endDate: d("2024-03-20"),
    employeeIds: ["emp-y"],
  }),
]

function run(partial: Partial<ChantierViewQuery>) {
  return applyChantierView(DATA, {
    state: DEFAULT_STATE_FILTER,
    search: "",
    filters: EMPTY_COMPLEMENTARY_FILTERS,
    sort: DEFAULT_SORT,
    ...partial,
  })
}

const ids = (r: { items: FilterableChantier[] }) => r.items.map((c) => c.id)

describe("Chantiers — états (statut persisté uniquement)", () => {
  it("A — un chantier en cours / prolongé apparaît dans Actifs", () => {
    assert.deepEqual(ids(run({ state: "active" })).sort(), ["active-lauralu", "extended-dupont"])
  })

  it("B — un chantier futur (PLANNED / DELAYED) apparaît dans Planifiés", () => {
    assert.deepEqual(ids(run({ state: "planned" })).sort(), ["delayed", "planned-lauralu", "planned-unassigned"])
  })

  it("C — la vue par défaut est Actifs et n'affiche aucun chantier terminé/archivé", () => {
    assert.equal(DEFAULT_STATE_FILTER, "active")
    const r = run({})
    assert.ok(!ids(r).includes("completed-lauralu"))
    assert.ok(!ids(r).includes("archived-old"))
  })

  it("D — Terminés retrouve COMPLETED + ARCHIVED", () => {
    assert.deepEqual(ids(run({ state: "done" })).sort(), ["archived-old", "completed-lauralu"])
  })

  it("E — Tous retrouve actifs + anciens", () => {
    assert.equal(run({ state: "all" }).items.length, DATA.length)
  })

  it("J — À affecter = règle existante (PLANNED && 0 affectation), DELAYED non inclus", () => {
    assert.deepEqual(ids(run({ state: "unassigned" })), ["planned-unassigned"])
    assert.equal(matchesState({ status: "DELAYED", _count: { assignments: 0 } }, "unassigned"), false)
    assert.equal(matchesState({ status: "PLANNED", _count: { assignments: 1 } }, "unassigned"), false)
  })

  it("une date de fin dépassée ne rend PAS un chantier « Terminé » (statut seul fait foi)", () => {
    const stale = chantier({ id: "stale", status: "IN_PROGRESS", endDate: d("2020-01-01") })
    assert.equal(matchesState(stale, "done"), false)
    assert.equal(matchesState(stale, "active"), true)
  })

  it("compteurs réels par état", () => {
    assert.deepEqual(run({}).counts, { active: 2, unassigned: 1, planned: 3, done: 2, all: 7 })
  })
})

describe("Chantiers — recherche", () => {
  it("F — par nom (insensible à la casse)", () => {
    assert.deepEqual(ids(run({ state: "all", search: "ZINGUERIE" })), ["delayed"])
  })

  it("G — par client", () => {
    assert.deepEqual(ids(run({ state: "all", search: "lauralu sas" })).sort(), [
      "active-lauralu",
      "completed-lauralu",
      "planned-lauralu",
    ])
  })

  it("H — par ville / code postal / adresse, insensible aux accents", () => {
    assert.deepEqual(ids(run({ state: "all", search: "lyon" })), ["extended-dupont"])
    assert.deepEqual(ids(run({ state: "all", search: "75009" })), ["planned-lauralu"])
    assert.deepEqual(ids(run({ state: "all", search: "chenove" })), ["planned-unassigned"])
    assert.deepEqual(ids(run({ state: "all", search: "rivoli" })), ["completed-lauralu"])
  })

  it("plusieurs termes = ET, sur n'importe quel champ", () => {
    assert.equal(matchesSearch(DATA[0], "lauralu paris"), true)
    assert.equal(matchesSearch(DATA[0], "lauralu lyon"), false)
  })

  it("I — combinaison recherche + état", () => {
    assert.deepEqual(ids(run({ state: "active", search: "Lauralu" })), ["active-lauralu"])
    assert.deepEqual(ids(run({ state: "done", search: "Lauralu" })), ["completed-lauralu"])
    assert.deepEqual(ids(run({ state: "all", search: "Paris" })).sort(), [
      "active-lauralu",
      "completed-lauralu",
      "planned-lauralu",
    ])
  })

  it("les compteurs reflètent la recherche", () => {
    assert.deepEqual(run({ search: "Lauralu" }).counts, { active: 1, unassigned: 0, planned: 1, done: 1, all: 3 })
  })
})

describe("Chantiers — tri", () => {
  it("tri A → Z", () => {
    assert.deepEqual(ids(run({ state: "all", sort: "name-asc" })), [
      "completed-lauralu",
      "archived-old",
      "planned-unassigned",
      "planned-lauralu",
      "extended-dupont",
      "active-lauralu",
      "delayed",
    ])
  })

  it("tri Z → A", () => {
    assert.deepEqual(ids(run({ state: "all", sort: "name-desc" })), [
      "delayed",
      "active-lauralu",
      "extended-dupont",
      "planned-lauralu",
      "planned-unassigned",
      "archived-old",
      "completed-lauralu",
    ])
  })

  it("tri date de début croissant / décroissant — dates inconnues toujours en fin", () => {
    assert.deepEqual(ids(run({ state: "all", sort: "start-asc" })), [
      "archived-old",
      "completed-lauralu",
      "extended-dupont",
      "active-lauralu",
      "planned-lauralu",
      "planned-unassigned",
      "delayed",
    ])
    assert.deepEqual(ids(run({ state: "all", sort: "start-desc" })), [
      "planned-unassigned",
      "planned-lauralu",
      "active-lauralu",
      "extended-dupont",
      "completed-lauralu",
      "archived-old",
      "delayed",
    ])
  })

  it("tri date de fin croissant / décroissant — dates inconnues toujours en fin", () => {
    assert.deepEqual(ids(run({ state: "all", sort: "end-asc" })), [
      "archived-old",
      "completed-lauralu",
      "extended-dupont",
      "active-lauralu",
      "planned-lauralu",
      "planned-unassigned",
      "delayed",
    ])
    const desc = ids(run({ state: "all", sort: "end-desc" }))
    assert.deepEqual(desc.slice(0, 5), [
      "planned-lauralu",
      "active-lauralu",
      "extended-dupont",
      "completed-lauralu",
      "archived-old",
    ])
    assert.deepEqual(desc.slice(5).sort(), ["delayed", "planned-unassigned"])
  })

  it("ne modifie pas le tableau source", () => {
    const before = DATA.map((c) => c.id)
    run({ state: "all", sort: "name-desc" })
    assert.deepEqual(DATA.map((c) => c.id), before)
  })
})

describe("Chantiers — filtres complémentaires", () => {
  it("filtre client", () => {
    assert.deepEqual(ids(run({ state: "all", filters: { clientId: "c-dupont", employeeId: null } })).sort(), [
      "archived-old",
      "extended-dupont",
      "planned-unassigned",
    ])
  })

  it("filtre personnel affecté", () => {
    assert.deepEqual(ids(run({ state: "all", filters: { clientId: null, employeeId: "emp-y" } })).sort(), [
      "active-lauralu",
      "archived-old",
      "extended-dupont",
    ])
  })

  it("combinaison état + recherche + filtre + tri", () => {
    const r = run({
      state: "done",
      search: "Lauralu",
      filters: { clientId: null, employeeId: "emp-x" },
      sort: "end-desc",
    })
    assert.deepEqual(ids(r), ["completed-lauralu"])

    const r2 = run({
      state: "all",
      search: "Lauralu",
      filters: { clientId: "c-lauralu", employeeId: "emp-x" },
      sort: "end-desc",
    })
    assert.deepEqual(ids(r2), ["planned-lauralu", "active-lauralu", "completed-lauralu"])
  })

  it("reset des filtres → retour au résultat par défaut", () => {
    const filtered = run({ filters: { clientId: "c-dupont", employeeId: "emp-x" } })
    assert.equal(filtered.items.length, 0)
    assert.equal(countActiveComplementaryFilters({ clientId: "c-dupont", employeeId: "emp-x" }), 2)
    const reset = run({ filters: EMPTY_COMPLEMENTARY_FILTERS, sort: DEFAULT_SORT })
    assert.equal(countActiveComplementaryFilters(EMPTY_COMPLEMENTARY_FILTERS), 0)
    assert.deepEqual(ids(reset), ids(run({})))
    assert.equal(reset.items.length, 2)
  })

  it("options client dérivées des chantiers autorisés, dédupliquées et triées", () => {
    assert.deepEqual(buildClientOptions(DATA), [
      { id: "c-dupont", label: "Dupont" },
      { id: "c-lauralu", label: "Lauralu SAS" },
      { id: "c-martin", label: "Martin" },
    ])
  })
})

describe("Chantiers — isolation tenant (K)", () => {
  const rows: EmployeeAssignmentRow[] = [
    { employeeId: "emp-x", employee: { companyId: "co-1", firstName: "Xavier", lastName: "Durand" }, assignment: { worksiteId: "w1" } },
    { employeeId: "emp-x", employee: { companyId: "co-1", firstName: "Xavier", lastName: "Durand" }, assignment: { worksiteId: "w1" } },
    { employeeId: "emp-a", employee: { companyId: "co-1", firstName: "Alice", lastName: "Bernard" }, assignment: { worksiteId: "w2" } },
    // Lignes d'un autre tenant ou d'un chantier non autorisé : doivent être ignorées.
    { employeeId: "emp-evil", employee: { companyId: "co-2", firstName: "Eve", lastName: "Autre" }, assignment: { worksiteId: "w1" } },
    { employeeId: "emp-z", employee: { companyId: "co-1", firstName: "Zoé", lastName: "Hors" }, assignment: { worksiteId: "w-other" } },
  ]

  it("le sélecteur de personnel n'expose que les employés du tenant courant sur des chantiers autorisés", () => {
    const { personnelOptions, employeeIdsByWorksite } = buildPersonnelIndex(rows, "co-1", new Set(["w1", "w2"]))
    assert.deepEqual(personnelOptions, [
      { id: "emp-a", label: "Alice Bernard" },
      { id: "emp-x", label: "Xavier Durand" },
    ])
    assert.deepEqual(employeeIdsByWorksite.get("w1"), ["emp-x"])
    assert.deepEqual(employeeIdsByWorksite.get("w2"), ["emp-a"])
    assert.equal(employeeIdsByWorksite.has("w-other"), false)
    assert.ok(!JSON.stringify(personnelOptions).includes("Eve"))
  })

  it("aucune donnée injectée : le pipeline ne renvoie que des éléments du tableau fourni", () => {
    const r = run({ state: "all" })
    const inputIds = new Set(DATA.map((c) => c.id))
    assert.ok(r.items.every((c) => inputIds.has(c.id)))
  })
})

describe("Chantiers — clé de remontage de la carte", () => {
  it("un changement de tri seul ne change pas la clé", () => {
    const byName = run({ state: "all", sort: "name-asc" }).items
    const byEnd = run({ state: "all", sort: "end-desc" }).items
    assert.notDeepEqual(ids({ items: byName }), ids({ items: byEnd }))
    assert.equal(buildChantierSetKey(byName), buildChantierSetKey(byEnd))
  })

  it("un changement de l'ensemble affiché change la clé", () => {
    const all = buildChantierSetKey(run({ state: "all" }).items)
    const active = buildChantierSetKey(run({ state: "active" }).items)
    const searched = buildChantierSetKey(run({ state: "all", search: "Lauralu" }).items)
    assert.notEqual(all, active)
    assert.notEqual(all, searched)
    assert.equal(buildChantierSetKey([]), "")
  })
})

describe("Chantiers — compteurs d'en-tête", () => {
  it("en cours = IN_PROGRESS + EXTENDED ; planifiés = PLANNED + DELAYED (mêmes règles que les onglets)", () => {
    assert.equal(DATA.filter((c) => matchesState(c, "active")).length, 2)
    assert.equal(DATA.filter((c) => matchesState(c, "planned")).length, 3)
    for (const status of ["IN_PROGRESS", "EXTENDED"]) {
      assert.equal(matchesState({ status, _count: { assignments: 0 } }, "active"), true)
    }
    for (const status of ["PLANNED", "DELAYED"]) {
      assert.equal(matchesState({ status, _count: { assignments: 0 } }, "planned"), true)
    }
  })
})

describe("Chantiers — badges de statut", () => {
  it("le badge n'est affiché que s'il apporte une information", () => {
    assert.equal(shouldShowStatusBadge("ARCHIVED", "done"), false)
    assert.equal(shouldShowStatusBadge("COMPLETED", "done"), false)
    assert.equal(shouldShowStatusBadge("ARCHIVED", "all"), true)
    assert.equal(shouldShowStatusBadge("IN_PROGRESS", "active"), false)
    assert.equal(shouldShowStatusBadge("EXTENDED", "active"), true)
    assert.equal(shouldShowStatusBadge("PLANNED", "planned"), false)
    assert.equal(shouldShowStatusBadge("DELAYED", "planned"), true)
  })
})
