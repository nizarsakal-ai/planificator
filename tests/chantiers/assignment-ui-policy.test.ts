import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { canShowAffecterEquipeForm } from "@/lib/chantiers/assignment-ui-policy"
import { groupAssignmentBlocks } from "@/lib/chantiers/assignment-blocks"

describe("canShowAffecterEquipeForm", () => {
  it("SUPER_ADMIN + IN_PROGRESS + endDate passée conceptuelle → visible", () => {
    assert.equal(
      canShowAffecterEquipeForm({ role: "SUPER_ADMIN", status: "IN_PROGRESS" }),
      true
    )
  })

  it("ADMIN + aucune affectation (status PLANNED/IN_PROGRESS) → visible", () => {
    assert.equal(canShowAffecterEquipeForm({ role: "ADMIN", status: "PLANNED" }), true)
    assert.equal(canShowAffecterEquipeForm({ role: "ADMIN", status: "IN_PROGRESS" }), true)
  })

  it("ADMIN + COMPLETED (auto-complete cron / fin dépassée) → visible pour correction", () => {
    assert.equal(canShowAffecterEquipeForm({ role: "ADMIN", status: "COMPLETED" }), true)
    assert.equal(canShowAffecterEquipeForm({ role: "SUPER_ADMIN", status: "COMPLETED" }), true)
  })

  it("ARCHIVED → masqué (règle terminale)", () => {
    assert.equal(canShowAffecterEquipeForm({ role: "ADMIN", status: "ARCHIVED" }), false)
    assert.equal(canShowAffecterEquipeForm({ role: "SUPER_ADMIN", status: "ARCHIVED" }), false)
  })

  it("utilisateur non autorisé → masqué", () => {
    assert.equal(canShowAffecterEquipeForm({ role: "EMPLOYEE", status: "IN_PROGRESS" }), false)
    assert.equal(canShowAffecterEquipeForm({ role: "TEAM_LEADER", status: "IN_PROGRESS" }), false)
    assert.equal(canShowAffecterEquipeForm({ role: "CLIENT", status: "IN_PROGRESS" }), false)
    assert.equal(canShowAffecterEquipeForm({ role: null, status: "IN_PROGRESS" }), false)
  })

  it("EXTENDED et DELAYED restent affectables pour ADMIN", () => {
    assert.equal(canShowAffecterEquipeForm({ role: "ADMIN", status: "EXTENDED" }), true)
    assert.equal(canShowAffecterEquipeForm({ role: "ADMIN", status: "DELAYED" }), true)
  })
})

describe("groupAssignmentBlocks", () => {
  it("retourne [] sans affectation (pas de régression message vide)", () => {
    assert.deepEqual(groupAssignmentBlocks([]), [])
  })

  it("regroupe les jours consécutifs d'une même équipe", () => {
    const blocks = groupAssignmentBlocks([
      {
        id: "a1",
        date: new Date("2026-07-15T00:00:00.000Z"),
        status: "CONFIRMED",
        teamId: "t-gutati",
        team: { name: "GUTATI", color: "#111" },
        employeeAssignments: [
          { employee: { id: "e1", firstName: "A", lastName: "B" } },
        ],
      },
      {
        id: "a2",
        date: new Date("2026-07-16T00:00:00.000Z"),
        status: "PENDING",
        teamId: "t-gutati",
        team: { name: "GUTATI", color: "#111" },
        employeeAssignments: [
          { employee: { id: "e1", firstName: "A", lastName: "B" } },
        ],
      },
      {
        id: "a3",
        date: new Date("2026-07-15T00:00:00.000Z"),
        status: "CONFIRMED",
        teamId: "t-makram",
        team: { name: "MAKRAM", color: "#222" },
        employeeAssignments: [],
      },
    ])

    assert.equal(blocks.length, 2)
    const gutati = blocks.find((b) => b.teamId === "t-gutati")
    const makram = blocks.find((b) => b.teamId === "t-makram")
    assert.ok(gutati)
    assert.ok(makram)
    assert.equal(gutati!.dayCount, 2)
    assert.equal(gutati!.status, "PENDING") // priorité refus/pending > confirmed
    assert.equal(makram!.dayCount, 1)
  })
})
