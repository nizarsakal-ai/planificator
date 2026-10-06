import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  applyEquipeView,
  computeEquipeStats,
  getEquipeMenuActions,
  matchesEquipeSearch,
  parisDateKey,
  parisTodayAsDbDate,
  splitAvatars,
  teamSizeHint,
  toEquipeViewItems,
  type EquipeQuery,
  type EquipeRow,
  type EquipeViewItem,
  type TodayAssignmentRow,
} from "@/lib/equipes/equipes-view"

const CO = "co-1"
const OTHER = "co-2"

const person = (id: string, firstName: string, lastName: string, companyId = CO) => ({ id, firstName, lastName, companyId })
const member = (id: string, firstName: string, lastName: string, companyId = CO, active = true) => ({
  employee: { ...person(id, firstName, lastName, companyId), avatarUrl: null, active },
})

function row(over: Partial<EquipeRow> & { id: string; name: string }): EquipeRow {
  return {
    companyId: CO,
    color: null,
    active: true,
    leader: person("lead-" + over.id, "Chef", over.name),
    members: [],
    truck: null,
    ...over,
  }
}

const ROWS: EquipeRow[] = [
  row({
    id: "t-alpha",
    name: "Équipe Alpha",
    leader: person("e1", "Hélène", "Dubois"),
    members: [member("e1", "Hélène", "Dubois"), member("e2", "Jérôme", "Martin"), member("e3", "Zoé", "Lefèvre")],
    truck: { id: "tr1", matricule: "AB-123-CD", marque: "Crafter", companyId: CO },
  }),
  row({
    id: "t-beta",
    name: "Bêta",
    leader: person("e4", "Paul", "Durand"),
    // e2 appartient aussi à Bêta : compté une seule fois.
    members: [member("e4", "Paul", "Durand"), member("e2", "Jérôme", "Martin")],
  }),
  row({
    id: "t-gamma",
    name: "Gamma",
    active: false,
    leader: person("e5", "Inès", "Roux"),
    members: [member("e5", "Inès", "Roux"), member("e6", "Luc", "Bernard")],
    truck: { id: "tr2", matricule: "EF-456-GH", marque: null, companyId: CO },
  }),
  row({
    id: "t-delta",
    name: "Delta",
    leader: person("e7", "Sami", "Benali"),
    members: [1, 2, 3, 4, 5, 6, 7].map((n) => member("d" + n, "Membre", "N" + n)),
    truck: { id: "tr3", matricule: "IJ-789-KL", marque: "Master", companyId: CO },
  }),
]

const assignment = (teamId: string, status: string, worksiteCompany = CO, name = "Chantier " + teamId): TodayAssignmentRow => ({
  teamId,
  status,
  worksite: { id: "w-" + teamId, name, latitude: null, longitude: null, companyId: worksiteCompany },
})

const ASSIGNMENTS: TodayAssignmentRow[] = [
  assignment("t-alpha", "CONFIRMED", CO, "Résidence Les Pins"),
  assignment("t-beta", "PENDING"),
  assignment("t-delta", "REFUSED"),
  // Équipe archivée avec affectation confirmée : jamais « en intervention ».
  assignment("t-gamma", "CONFIRMED"),
]

const ITEMS = toEquipeViewItems(ROWS, ASSIGNMENTS, CO)
const byId = (id: string) => ITEMS.find((t) => t.id === id)!

const Q = (over: Partial<EquipeQuery> = {}): EquipeQuery => ({ tab: "all", search: "", vehicle: "all", sort: "name-asc", ...over })
const names = (items: EquipeViewItem[]) => items.map((t) => t.name)

describe("Équipes — journée Europe/Paris", () => {
  it("23:30 UTC en été = lendemain à Paris (UTC+2)", () => {
    assert.equal(parisDateKey(new Date("2026-07-14T22:30:00Z")), "2026-07-15")
    assert.equal(parisDateKey(new Date("2026-07-14T21:59:59Z")), "2026-07-14")
  })

  it("en hiver (UTC+1) la bascule a lieu à 23:00 UTC", () => {
    assert.equal(parisDateKey(new Date("2026-01-10T22:59:59Z")), "2026-01-10")
    assert.equal(parisDateKey(new Date("2026-01-10T23:00:00Z")), "2026-01-11")
  })

  it("00:30 UTC est déjà le même jour à Paris ; changements d'heure", () => {
    assert.equal(parisDateKey(new Date("2026-03-01T00:30:00Z")), "2026-03-01")
    assert.equal(parisDateKey(new Date("2026-03-28T23:30:00Z")), "2026-03-29") // nuit du passage à l'heure d'été
    assert.equal(parisDateKey(new Date("2026-10-24T22:30:00Z")), "2026-10-25") // nuit du passage à l'heure d'hiver
  })

  it("valeur @db.Date = minuit UTC du jour parisien, indépendante du fuseau serveur", () => {
    const d = parisTodayAsDbDate(new Date("2026-07-14T22:30:00Z"))
    assert.equal(d.toISOString(), "2026-07-15T00:00:00.000Z")
  })
})

describe("Équipes — projection tenant (défense en profondeur)", () => {
  it("ignore équipes, chefs, membres, véhicules et chantiers d'un autre tenant", () => {
    const rows: EquipeRow[] = [
      row({ id: "foreign", name: "Étrangère", companyId: OTHER }),
      row({ id: "bad-leader", name: "Chef étranger", leader: person("x", "X", "Y", OTHER) }),
      row({
        id: "mixed",
        name: "Mixte",
        members: [member("m1", "A", "A"), member("m2", "B", "B", OTHER)],
        truck: { id: "trx", matricule: "XX", marque: null, companyId: OTHER },
      }),
    ]
    const items = toEquipeViewItems(rows, [assignment("mixed", "CONFIRMED", OTHER)], CO)
    assert.deepEqual(items.map((t) => t.id), ["mixed"])
    assert.deepEqual(items[0].members.map((m) => m.id), ["m1"])
    assert.equal(items[0].truck, null)
    assert.equal(items[0].currentWorksite, null)
  })

  it("ne projette aucun champ sensible (email, téléphone, companyId)", () => {
    const json = JSON.stringify(ITEMS)
    assert.doesNotMatch(json, /companyId|email|phone/)
  })

  it("PENDING et REFUSED ne donnent pas de chantier du jour ; CONFIRMED oui", () => {
    assert.deepEqual(byId("t-alpha").currentWorksite, { id: "w-t-alpha", name: "Résidence Les Pins", latitude: null, longitude: null })
    assert.equal(byId("t-beta").currentWorksite, null)
    assert.equal(byId("t-delta").currentWorksite, null)
  })
})

describe("Équipes — KPI", () => {
  it("définitions exactes", () => {
    const stats = computeEquipeStats(ITEMS, 4)
    assert.equal(stats.activeTeams, 3) // Alpha, Bêta, Delta
    assert.equal(stats.totalTeams, 4)
    // Alpha {e1,e2,e3} ∪ Bêta {e4,e2} ∪ Delta {d1..d7} = 3 + 1 + 7 ; Gamma (archivée) exclue.
    assert.equal(stats.assignedMembers, 11)
    assert.equal(stats.employeesWithoutTeam, 4)
    assert.equal(stats.teamsWithVehicle, 2) // Alpha, Delta ; Gamma archivée exclue
  })

  it("« Membres affectés » : un employé désactivé n'est pas compté (même membre d'une équipe active)", () => {
    const items = toEquipeViewItems(
      [
        row({
          id: "a",
          name: "A",
          members: [member("x1", "Actif", "Un"), member("x2", "Inactif", "Deux", CO, false)],
        }),
        row({ id: "b", name: "B", members: [member("x2", "Inactif", "Deux", CO, false), member("x3", "Actif", "Trois")] }),
      ],
      [],
      CO
    )
    assert.equal(computeEquipeStats(items, 0).assignedMembers, 2) // x1, x3
    // L'affichage de l'équipe n'est pas modifié : le membre reste listé.
    assert.equal(items[0].members.length, 2)
  })

  it("aucune équipe → zéros", () => {
    assert.deepEqual(computeEquipeStats([], 0), {
      activeTeams: 0,
      totalTeams: 0,
      assignedMembers: 0,
      employeesWithoutTeam: 0,
      teamsWithVehicle: 0,
    })
  })
})

describe("Équipes — onglets et compteurs", () => {
  it("compteurs par onglet", () => {
    assert.deepEqual(applyEquipeView(ITEMS, Q()).counts, {
      all: 4,
      active: 3,
      inIntervention: 1,
      withoutVehicle: 1,
      archived: 1,
    })
  })

  it("contenu de chaque onglet", () => {
    assert.deepEqual(names(applyEquipeView(ITEMS, Q({ tab: "active" })).items), ["Bêta", "Delta", "Équipe Alpha"])
    assert.deepEqual(names(applyEquipeView(ITEMS, Q({ tab: "inIntervention" })).items), ["Équipe Alpha"])
    assert.deepEqual(names(applyEquipeView(ITEMS, Q({ tab: "withoutVehicle" })).items), ["Bêta"])
    assert.deepEqual(names(applyEquipeView(ITEMS, Q({ tab: "archived" })).items), ["Gamma"])
  })

  it("les compteurs suivent la recherche et le filtre véhicule", () => {
    const { counts } = applyEquipeView(ITEMS, Q({ search: "martin" }))
    assert.deepEqual(counts, { all: 2, active: 2, inIntervention: 1, withoutVehicle: 1, archived: 0 })
    assert.equal(applyEquipeView(ITEMS, Q({ vehicle: "with" })).counts.withoutVehicle, 0)
  })
})

describe("Équipes — recherche", () => {
  it("insensible à la casse et aux accents, sur nom d'équipe, chef et membres", () => {
    assert.ok(matchesEquipeSearch(byId("t-alpha"), "EQUIPE alpha"))
    assert.ok(matchesEquipeSearch(byId("t-beta"), "beta"))
    assert.ok(matchesEquipeSearch(byId("t-alpha"), "helene"))
    assert.ok(matchesEquipeSearch(byId("t-alpha"), "lefevre"))
    assert.ok(matchesEquipeSearch(byId("t-alpha"), "  Jérôme  martin "))
    assert.ok(!matchesEquipeSearch(byId("t-beta"), "lefevre"))
  })

  it("plusieurs termes = ET ; recherche vide = tout", () => {
    assert.deepEqual(names(applyEquipeView(ITEMS, Q({ search: "jerome paul" })).items), ["Bêta"])
    assert.equal(applyEquipeView(ITEMS, Q({ search: "   " })).items.length, 4)
  })

  it("ne cherche pas dans le véhicule ni le chantier", () => {
    assert.equal(applyEquipeView(ITEMS, Q({ search: "crafter" })).items.length, 0)
    assert.equal(applyEquipeView(ITEMS, Q({ search: "pins" })).items.length, 0)
  })
})

describe("Équipes — filtres et tris", () => {
  it("« Sans véhicule » identique pour l'onglet, son compteur et le filtre : équipes ACTIVES uniquement", () => {
    const items = [
      ...ITEMS,
      ...toEquipeViewItems([row({ id: "t-old", name: "Ancienne", active: false })], [], CO),
    ]
    const tab = applyEquipeView(items, Q({ tab: "withoutVehicle" }))
    const filter = applyEquipeView(items, Q({ vehicle: "without" }))
    assert.deepEqual(names(tab.items), ["Bêta"])
    assert.equal(tab.counts.withoutVehicle, 1)
    assert.deepEqual(names(filter.items), ["Bêta"]) // l'équipe archivée sans véhicule n'apparaît pas
    assert.equal(filter.counts.archived, 0)
    assert.equal(filter.counts.withoutVehicle, 1)
  })

  it("filtre véhicule Tous / Avec / Sans", () => {
    assert.equal(applyEquipeView(ITEMS, Q({ vehicle: "all" })).items.length, 4)
    // « Avec véhicule » = équipes ACTIVES avec véhicule : Gamma (archivée, avec camion) exclue.
    assert.deepEqual(names(applyEquipeView(ITEMS, Q({ vehicle: "with" })).items), ["Delta", "Équipe Alpha"])
    assert.equal(applyEquipeView(ITEMS, Q({ vehicle: "with" })).counts.archived, 0)
    assert.deepEqual(names(applyEquipeView(ITEMS, Q({ vehicle: "without" })).items), ["Bêta"])
  })

  it("tri par nom A→Z / Z→A (collation française, accents ignorés)", () => {
    assert.deepEqual(names(applyEquipeView(ITEMS, Q()).items), ["Bêta", "Delta", "Équipe Alpha", "Gamma"])
    assert.deepEqual(names(applyEquipeView(ITEMS, Q({ sort: "name-desc" })).items), ["Gamma", "Équipe Alpha", "Delta", "Bêta"])
  })

  it("tri par nombre de membres, égalités départagées par le nom", () => {
    assert.deepEqual(names(applyEquipeView(ITEMS, Q({ sort: "members-asc" })).items), ["Bêta", "Gamma", "Équipe Alpha", "Delta"])
    assert.deepEqual(names(applyEquipeView(ITEMS, Q({ sort: "members-desc" })).items), ["Delta", "Équipe Alpha", "Bêta", "Gamma"])
  })

  it("ne mute pas l'entrée", () => {
    const before = ITEMS.map((t) => t.id)
    applyEquipeView(ITEMS, Q({ sort: "name-desc" }))
    assert.deepEqual(ITEMS.map((t) => t.id), before)
  })
})

describe("Équipes — présentation", () => {
  it("avatars : 4 visibles puis +N", () => {
    assert.deepEqual(splitAvatars([1, 2, 3]), { visible: [1, 2, 3], overflow: 0 })
    assert.deepEqual(splitAvatars([1, 2, 3, 4, 5, 6, 7]), { visible: [1, 2, 3, 4], overflow: 3 })
  })

  it("repère de taille présenté comme une recommandation, jamais comme une capacité", () => {
    assert.equal(teamSizeHint(5).label, "Membres : 5 · recommandation 5–6")
    assert.equal(teamSizeHint(3).tone, "under")
    assert.equal(teamSizeHint(6).tone, "ok")
    assert.equal(teamSizeHint(8).tone, "over")
    assert.equal(teamSizeHint(8).ratio, 1)
    assert.doesNotMatch(teamSizeHint(5).label, /capacit|\/6/i)
  })
})

describe("Équipes — RBAC du menu « ••• »", () => {
  it("gestionnaire, équipe active : Voir, Modifier, Membres, Véhicule, Archiver", () => {
    assert.deepEqual(getEquipeMenuActions(true, true), ["view", "edit", "members", "vehicle", "archive"])
  })

  it("gestionnaire, équipe archivée : Voir, Modifier, Restaurer", () => {
    assert.deepEqual(getEquipeMenuActions(false, true), ["view", "edit", "restore"])
  })

  it("sans droit de gestion : consultation uniquement", () => {
    assert.deepEqual(getEquipeMenuActions(true, false), ["view"])
    assert.deepEqual(getEquipeMenuActions(false, false), ["view"])
  })

  it("jamais de suppression ni d'affectation de chantier", () => {
    for (const a of [true, false]) for (const m of [true, false]) {
      const actions: string[] = getEquipeMenuActions(a, m)
      assert.ok(!actions.some((x) => /delete|remove|assign/i.test(x)))
    }
  })
})
