// VEHICLES V1C — logique pure de la page Véhicules (aucune DB, aucun React).
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  DEFAULT_VEHICLE_FILTERS,
  DEFAULT_VEHICLE_QUERY,
  NO_DRIVER,
  NO_TEAM,
  VEHICLE_IDENTITY_FALLBACK,
  applyVehicleView,
  computeVehicleStats,
  countActiveFilters,
  driverFilterOptions,
  formatVehicleIdentity,
  historyReasonLabel,
  isVehicleFormSubmittable,
  limitHistory,
  matchesSearch,
  normalizeSearch,
  resolveVehiclesAccess,
  sortVehicles,
  teamFilterOptions,
  toTruckPayload,
  vehicleAssignmentBadge,
  isAssigned,
  vehicleIdentityLabel,
  vehicleOptionLabel,
  vehicleToFormValues,
  type VehicleQuery,
  type VehicleViewItem,
} from "@/lib/vehicules/vehicules-view"

const T1 = { id: "team-1", name: "Équipe Nord", color: "#123456" }
const T2 = { id: "team-2", name: "Bêta", color: null }
const D1 = { id: "emp-1", firstName: "Hélène", lastName: "Dupont" }
const D2 = { id: "emp-2", firstName: "Jean", lastName: "Martin" }

const v = (over: Partial<VehicleViewItem> & { id: string; matricule: string }): VehicleViewItem => ({
  marque: null,
  modele: null,
  active: true,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  team: null,
  chauffeur: null,
  history: [],
  historyTruncated: false,
  ...over,
})

const ITEMS: VehicleViewItem[] = [
  v({ id: "a", matricule: "AB-123-CD", marque: "Volkswagen", modele: "Crafter", team: T1, chauffeur: D1, createdAt: "2026-03-01T00:00:00.000Z" }),
  v({ id: "b", matricule: "EF-456-GH", marque: "VW Crafter", team: T2, createdAt: "2026-02-01T00:00:00.000Z" }), // legacy : marque seule
  v({ id: "c", matricule: "IJ-789-KL", modele: "Master", chauffeur: D2, createdAt: "2026-04-01T00:00:00.000Z" }), // modèle seul
  v({ id: "d", matricule: "MN-012-OP", createdAt: "2026-05-01T00:00:00.000Z" }), // aucun
  v({ id: "e", matricule: "QR-345-ST", marque: "Renault", modele: "Trafic", active: false, archivedAt: "2026-06-01T00:00:00.000Z" }),
]

const Q = (over: Partial<VehicleQuery> = {}): VehicleQuery => ({ ...DEFAULT_VEHICLE_QUERY, ...over })
const ids = (items: VehicleViewItem[]) => items.map((i) => i.id)

describe("identité", () => {
  it("marque + modèle", () => assert.equal(formatVehicleIdentity("Volkswagen", "Crafter"), "Volkswagen Crafter"))
  it("legacy : marque seule inchangée, jamais découpée", () => {
    assert.equal(formatVehicleIdentity("VW Crafter", null), "VW Crafter")
    assert.equal(vehicleIdentityLabel("VW Crafter", null), "VW Crafter")
  })
  it("modèle seul", () => assert.equal(formatVehicleIdentity(null, "Master"), "Master"))
  it("aucun / blancs → null, repli lisible", () => {
    assert.equal(formatVehicleIdentity(null, null), null)
    assert.equal(formatVehicleIdentity("  ", ""), null)
    assert.equal(vehicleIdentityLabel(null, null), VEHICLE_IDENTITY_FALLBACK)
  })
  it("espaces de bord retirés, pas de double espace", () => assert.equal(formatVehicleIdentity(" Renault ", " Trafic "), "Renault Trafic"))
  it("libellé de sélecteur", () => {
    assert.equal(vehicleOptionLabel({ matricule: "AB-1", marque: "VW", modele: "Crafter" }), "AB-1 — VW Crafter")
    assert.equal(vehicleOptionLabel({ matricule: "AB-1", marque: "VW Crafter", modele: null }), "AB-1 — VW Crafter")
    assert.equal(vehicleOptionLabel({ matricule: "AB-1" }), "AB-1")
  })
})

describe("formulaire", () => {
  it("valeurs initiales depuis un véhicule (null → vide)", () => {
    assert.deepEqual(vehicleToFormValues({ matricule: "AB-1", marque: null, modele: "Master" }), { matricule: "AB-1", marque: "", modele: "Master" })
  })
  it("payload trimé ; la marque legacy n'est jamais découpée", () => {
    assert.deepEqual(toTruckPayload({ matricule: " ab-1 ", marque: " VW Crafter ", modele: "" }), { matricule: "ab-1", marque: "VW Crafter", modele: "" })
  })
  it("soumission : matricule requis", () => {
    assert.equal(isVehicleFormSubmittable({ matricule: "  ", marque: "x", modele: "y" }), false)
    assert.equal(isVehicleFormSubmittable({ matricule: "AB-1", marque: "", modele: "" }), true)
  })
})

describe("recherche", () => {
  it("normalisation accents / casse / espaces", () => {
    assert.equal(normalizeSearch("  HÉLÈNE   Dupont "), "helene dupont")
    assert.equal(normalizeSearch(null), "")
  })
  const found = (q: string) => ids(ITEMS.filter((i) => matchesSearch(i, q)))
  it("matricule (insensible à la casse)", () => assert.deepEqual(found("ab-123"), ["a"]))
  it("marque, modèle et identité composée", () => {
    assert.deepEqual(found("volkswagen"), ["a"])
    assert.deepEqual(found("crafter"), ["a", "b"])
    assert.deepEqual(found("master"), ["c"])
    assert.deepEqual(found("volkswagen crafter"), ["a"])
  })
  it("équipe (accents ignorés)", () => {
    assert.deepEqual(found("equipe nord"), ["a"])
    assert.deepEqual(found("beta"), ["b"])
  })
  it("chauffeur : prénom, nom, prénom nom, nom prénom, accents", () => {
    assert.deepEqual(found("helene"), ["a"])
    assert.deepEqual(found("DUPONT"), ["a"])
    assert.deepEqual(found("hélène dupont"), ["a"])
    assert.deepEqual(found("martin jean"), ["c"])
  })
  it("vide → tout ; sans résultat → rien", () => {
    assert.equal(found("   ").length, ITEMS.length)
    assert.deepEqual(found("introuvable"), [])
  })
})

describe("KPIs", () => {
  it("total / actifs / affectés / sans équipe / archivés", () => {
    assert.deepEqual(computeVehicleStats(ITEMS), { total: 5, active: 4, assigned: 3, withoutTeam: 2, archived: 1 })
  })
  it("affecté = équipe OU chauffeur ; un archivé n'est jamais affecté ni « sans équipe »", () => {
    const archivedWithRelations = v({ id: "z", matricule: "ZZ", active: false, team: T1, chauffeur: D1 }) // legacy impossible en DB, jamais compté
    const s = computeVehicleStats([archivedWithRelations])
    assert.equal(s.assigned, 0)
    assert.equal(s.withoutTeam, 0)
    assert.equal(s.archived, 1)
  })
  it("liste vide", () => assert.deepEqual(computeVehicleStats([]), { total: 0, active: 0, assigned: 0, withoutTeam: 0, archived: 0 }))
})

describe("onglets et compteurs", () => {
  it("Actifs / Archivés / Tous", () => {
    assert.deepEqual(ids(applyVehicleView(ITEMS, Q({ tab: "active" })).items), ["a", "b", "c", "d"])
    assert.deepEqual(ids(applyVehicleView(ITEMS, Q({ tab: "archived" })).items), ["e"])
    assert.equal(applyVehicleView(ITEMS, Q({ tab: "all" })).items.length, 5)
  })
  it("compteurs : recherche et filtres appliqués, onglet ignoré", () => {
    assert.deepEqual(applyVehicleView(ITEMS, Q()).counts, { all: 5, active: 4, archived: 1 })
    assert.deepEqual(applyVehicleView(ITEMS, Q({ search: "renault" })).counts, { all: 1, active: 0, archived: 1 })
  })
})

describe("filtres", () => {
  const res = (filters: Partial<typeof DEFAULT_VEHICLE_FILTERS>, tab: VehicleQuery["tab"] = "all") =>
    ids(applyVehicleView(ITEMS, Q({ tab, filters: { ...DEFAULT_VEHICLE_FILTERS, ...filters } })).items)
  it("équipe, sans équipe", () => {
    assert.deepEqual(res({ teamId: "team-1" }), ["a"])
    assert.deepEqual(res({ teamId: NO_TEAM }), ["c", "d", "e"])
  })
  it("chauffeur, sans chauffeur", () => {
    assert.deepEqual(res({ chauffeurId: "emp-2" }), ["c"])
    assert.deepEqual(res({ chauffeurId: NO_DRIVER }), ["b", "d", "e"])
  })
  it("statut d'affectation", () => {
    assert.deepEqual(res({ assignment: "assigned" }), ["a", "b", "c"])
    assert.deepEqual(res({ assignment: "unassigned" }), ["d", "e"])
  })
  it("combinaison et comptage", () => {
    assert.deepEqual(res({ teamId: "team-1", chauffeurId: "emp-1" }), ["a"])
    assert.deepEqual(res({ teamId: "team-1", chauffeurId: "emp-2" }), [])
    assert.equal(countActiveFilters({ teamId: "x", chauffeurId: null, assignment: "assigned" }), 2)
    assert.equal(countActiveFilters(DEFAULT_VEHICLE_FILTERS), 0)
  })
  it("options de filtre : équipes et chauffeurs présents, triés", () => {
    assert.deepEqual(teamFilterOptions(ITEMS).map((o) => o.label), ["Bêta", "Équipe Nord"])
    assert.deepEqual(driverFilterOptions(ITEMS).map((o) => o.label), ["Hélène Dupont", "Jean Martin"])
  })
})

describe("tri", () => {
  it("immatriculation (défaut), déterministe", () => {
    assert.deepEqual(ids(sortVehicles([ITEMS[3], ITEMS[0], ITEMS[4]], "matricule")), ["a", "d", "e"])
  })
  it("marque / modèle : alphabétique, sans identité en fin", () => {
    assert.deepEqual(ids(sortVehicles(ITEMS, "identity")), ["c", "e", "a", "b", "d"])
  })
  it("date de création : plus récents d'abord", () => {
    // e est sans createdAt distinct (2026-01-01) : le plus ancien.
    assert.deepEqual(ids(sortVehicles(ITEMS, "created")), ["d", "c", "a", "b", "e"])
  })
  it("ne mute pas l'entrée", () => {
    const copy = [...ITEMS]
    sortVehicles(ITEMS, "identity")
    assert.deepEqual(ITEMS, copy)
  })
})

describe("historique", () => {
  it("libellés des motifs (jamais le nom technique)", () => {
    assert.equal(historyReasonLabel("CREATED"), "Création")
    assert.equal(historyReasonLabel("REASSIGNED"), "Réaffectation")
    assert.equal(historyReasonLabel("DISPLACED"), "Déplacement")
    assert.equal(historyReasonLabel("ARCHIVED"), "Archivage")
    assert.equal(historyReasonLabel("RESTORED"), "Restauration")
    assert.equal(historyReasonLabel("BACKFILL"), "Historique initial")
  })
  it("motif inconnu ou absent → null (rien d'inventé, pas de nom brut)", () => {
    assert.equal(historyReasonLabel(null), null)
    assert.equal(historyReasonLabel("TOSTRING"), null)
    assert.equal(historyReasonLabel("constructor"), null)
  })
  it("troncature : LIMIT + 1 éléments prouvent l'existence de périodes plus anciennes", () => {
    const rows = Array.from({ length: 21 }, (_, i) => i)
    assert.deepEqual(limitHistory(rows), { entries: rows.slice(0, 20), truncated: true })
    assert.deepEqual(limitHistory(rows.slice(0, 20)), { entries: rows.slice(0, 20), truncated: false })
    assert.deepEqual(limitHistory([]), { entries: [], truncated: false })
  })
})

describe("accès à la page (SUPER_ADMIN sans entreprise)", () => {
  it("non authentifié → /login", () => assert.deepEqual(resolveVehiclesAccess(null), { kind: "redirect", to: "/login" }))
  it("rôles non autorisés → /dashboard", () => {
    for (const role of ["EMPLOYEE", "TEAM_LEADER", "CLIENT"]) {
      assert.deepEqual(resolveVehiclesAccess({ user: { role, companyId: "co" } }), { kind: "redirect", to: "/dashboard" })
    }
  })
  it("ADMIN / SUPER_ADMIN avec entreprise → ok, companyId de session", () => {
    assert.deepEqual(resolveVehiclesAccess({ user: { role: "ADMIN", companyId: "co-1" } }), { kind: "ok", companyId: "co-1" })
    assert.deepEqual(resolveVehiclesAccess({ user: { role: "SUPER_ADMIN", companyId: "co-1" } }), { kind: "ok", companyId: "co-1" })
  })
  it("SUPER_ADMIN sans entreprise (null / vide / absent) → redirection, aucune requête Truck possible", () => {
    for (const companyId of [null, "", "   ", undefined]) {
      assert.deepEqual(resolveVehiclesAccess({ user: { role: "SUPER_ADMIN", companyId } }), { kind: "redirect", to: "/super-admin/entreprises" })
    }
  })
  it("ADMIN sans entreprise → /dashboard", () => {
    assert.deepEqual(resolveVehiclesAccess({ user: { role: "ADMIN", companyId: null } }), { kind: "redirect", to: "/dashboard" })
  })
  it("la page n'utilise plus session.user.companyId!", async () => {
    const { readFileSync } = await import("node:fs")
    const page = readFileSync("src/app/(dashboard)/vehicules/page.tsx", "utf8")
    assert.doesNotMatch(page, /companyId!/)
    assert.match(page, /resolveVehiclesAccess\(session\)/)
    assert.match(page, /where: \{ companyId \}/)
  })
})

describe("badge d'affectation (même définition que KPI et filtre)", () => {
  const T = { id: "t", name: "Équipe Nord", color: null }
  const D = { id: "d", firstName: "Jean", lastName: "Martin" }
  const badge = (over: Partial<VehicleViewItem>) => vehicleAssignmentBadge(v({ id: "x", matricule: "X", ...over }))

  it("A) équipe + chauffeur → affecté (nom de l'équipe)", () => assert.deepEqual(badge({ team: T, chauffeur: D }), { label: "Équipe Nord", assigned: true }))
  it("B) équipe seule → affecté", () => assert.deepEqual(badge({ team: T }), { label: "Équipe Nord", assigned: true }))
  it("C) chauffeur seul → « Affecté » (jamais « Non affecté »)", () => assert.deepEqual(badge({ chauffeur: D }), { label: "Affecté", assigned: true }))
  it("D) ni équipe ni chauffeur → « Non affecté »", () => assert.deepEqual(badge({}), { label: "Non affecté", assigned: false }))
  it("E) archivé : « Archivé », jamais présenté comme affecté (même avec relations legacy)", () => {
    assert.deepEqual(badge({ active: false, archivedAt: "2026-06-01T00:00:00.000Z" }), { label: "Archivé", assigned: false })
    assert.deepEqual(badge({ active: false, team: T, chauffeur: D }), { label: "Archivé", assigned: false })
  })
  it("cohérence : badge, KPI « Affectés » et filtre « Affectés » s'accordent sur chaque cas", () => {
    const cases: VehicleViewItem[] = [
      v({ id: "1", matricule: "1", team: T, chauffeur: D }),
      v({ id: "2", matricule: "2", team: T }),
      v({ id: "3", matricule: "3", chauffeur: D }),
      v({ id: "4", matricule: "4" }),
      v({ id: "5", matricule: "5", active: false, team: T, chauffeur: D }),
    ]
    for (const c of cases) assert.equal(vehicleAssignmentBadge(c).assigned, isAssigned(c), c.id)
    assert.equal(computeVehicleStats(cases).assigned, cases.filter((c) => vehicleAssignmentBadge(c).assigned).length)
    const filtered = applyVehicleView(cases, Q({ tab: "all", filters: { ...DEFAULT_VEHICLE_FILTERS, assignment: "assigned" } })).items
    assert.deepEqual(ids(filtered), cases.filter((c) => vehicleAssignmentBadge(c).assigned).map((c) => c.id))
  })
})
