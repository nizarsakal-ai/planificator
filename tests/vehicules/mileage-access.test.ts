import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  assertMileageAccess,
  requireMileageSession,
  type MileageAccessContext,
  type MileageAction,
  type MileageSession,
} from "@/lib/vehicules/mileage-access"
import { MileageDomainError } from "@/lib/vehicules/mileage-domain"

const COMPANY = "company-A"
const ACTIONS: MileageAction[] = ["READ", "READING", "START", "END", "CORRECTION"]

function context(role = "TEAM_LEADER"): MileageAccessContext {
  return {
    companyId: COMPANY,
    sessionRole: role,
    actor: { id: "user-leader", role, companyId: COMPANY, active: true, name: "Chef" },
    truck: { companyId: COMPANY, teamId: "team-1" },
    employee: { id: "employee-leader", userId: "user-leader", companyId: COMPANY, active: true },
    team: { id: "team-1", companyId: COMPANY, leaderId: "employee-leader", active: true },
  }
}

function rejects(operation: () => unknown, code: string, status: number) {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof MileageDomainError)
    assert.equal(error.code, code)
    assert.equal(error.status, status)
    return true
  })
}

describe("V2 accès — session serveur", () => {
  it("absence de session, utilisateur ou identifiant : 401", () => {
    const sessions: Array<MileageSession | null> = [
      null, {}, { user: null }, { user: {} },
      { user: { id: "", role: "ADMIN", companyId: COMPANY } },
      { user: { id: null, role: "ADMIN", companyId: COMPANY } },
    ]
    for (const session of sessions) rejects(() => requireMileageSession(session), "UNAUTHENTICATED", 401)
  })

  it("les trois rôles autorisés conservent l'identité et le companyId explicite de session", () => {
    for (const role of ["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"]) {
      assert.deepEqual(requireMileageSession({ user: { id: "user-1", role, companyId: ` ${COMPANY} ` } }), {
        userId: "user-1", role, companyId: COMPANY,
      })
    }
  })

  it("EMPLOYEE, CLIENT, rôle absent ou inconnu : 403, même avec une entreprise valide", () => {
    for (const role of ["EMPLOYEE", "CLIENT", "UNKNOWN", null, undefined]) {
      rejects(() => requireMileageSession({ user: { id: "user-1", role, companyId: COMPANY } }), "FORBIDDEN", 403)
    }
  })

  it("aucun rôle, y compris SUPER_ADMIN global, ne déduit une entreprise absente", () => {
    for (const role of ["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"]) {
      for (const companyId of [null, undefined, "", "   "]) {
        rejects(() => requireMileageSession({ user: { id: "user-1", role, companyId } }), "NO_COMPANY", 403)
      }
    }
  })
})

describe("V2 accès — matrice rôles/actions", () => {
  for (const role of ["SUPER_ADMIN", "ADMIN", "TEAM_LEADER", "EMPLOYEE", "CLIENT"]) {
    for (const action of ACTIONS) {
      const allowed = role === "ADMIN" || role === "SUPER_ADMIN"
        || (role === "TEAM_LEADER" && ["READ", "START", "END"].includes(action))
      it(`${role} ${action} : ${allowed ? "autorisé" : "refusé"}`, () => {
        const run = () => assertMileageAccess(action, context(role))
        if (allowed) assert.doesNotThrow(run)
        else rejects(run, "FORBIDDEN", 403)
      })
    }
  }

  it("ADMIN/SUPER_ADMIN n'ont besoin ni d'un profil employé ni d'une équipe affectée", () => {
    for (const role of ["ADMIN", "SUPER_ADMIN"]) {
      const current = context(role)
      current.employee = null
      current.team = null
      current.truck.teamId = null
      for (const action of ACTIONS) assert.doesNotThrow(() => assertMileageAccess(action, current))
    }
  })
})

describe("V2 accès — autorité relue et isolation tenant", () => {
  it("un utilisateur désactivé après création de session est refusé pour toute action", () => {
    for (const role of ["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"]) {
      const current = context(role)
      current.actor.active = false
      for (const action of ACTIONS) rejects(() => assertMileageAccess(action, current), "UNAUTHENTICATED", 401)
    }
  })

  it("un rôle révoqué ou modifié pendant la requête exige une nouvelle session cohérente", () => {
    for (const [sessionRole, currentRole] of [
      ["ADMIN", "EMPLOYEE"], ["SUPER_ADMIN", "ADMIN"], ["TEAM_LEADER", "EMPLOYEE"], ["TEAM_LEADER", "ADMIN"],
    ]) {
      const current = context(sessionRole)
      current.actor.role = currentRole
      for (const action of ACTIONS) rejects(() => assertMileageAccess(action, current), "FORBIDDEN", 403)
    }
  })

  it("ADMIN/TL doivent toujours appartenir au companyId de session", () => {
    for (const role of ["ADMIN", "TEAM_LEADER"]) {
      for (const companyId of ["company-B", null]) {
        const current = context(role)
        current.actor.companyId = companyId
        rejects(() => assertMileageAccess("READ", current), "FORBIDDEN", 403)
      }
    }
  })

  it("SUPER_ADMIN global accepte seulement le contexte société fourni par la session serveur", () => {
    const current = context("SUPER_ADMIN")
    current.actor.companyId = null
    current.employee = null
    current.team = null
    for (const action of ACTIONS) assert.doesNotThrow(() => assertMileageAccess(action, current))
    current.truck.companyId = "company-B"
    rejects(() => assertMileageAccess("READ", current), "TRUCK_NOT_FOUND", 404)
  })

  it("un SUPER_ADMIN rattaché à une autre société n'a pas de bypass", () => {
    const current = context("SUPER_ADMIN")
    current.actor.companyId = "company-B"
    rejects(() => assertMileageAccess("READ", current), "FORBIDDEN", 403)
  })

  it("aucun rôle autorisé ne lit un véhicule d'un autre tenant", () => {
    for (const role of ["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"]) {
      const current = context(role)
      current.truck.companyId = "company-B"
      rejects(() => assertMileageAccess("READ", current), "TRUCK_NOT_FOUND", 404)
    }
  })
})

describe("V2 accès — équipe actuellement dirigée", () => {
  it("profil Employee manquant, inactif, étranger ou lié à un autre User : refus", () => {
    const invalidEmployees: MileageAccessContext["employee"][] = [
      null,
      { ...context().employee!, active: false },
      { ...context().employee!, companyId: "company-B" },
      { ...context().employee!, userId: "another-user" },
    ]
    for (const employee of invalidEmployees) {
      for (const action of ["READ", "START", "END"] as const) {
        rejects(() => assertMileageAccess(action, { ...context(), employee }), "FORBIDDEN", 403)
      }
    }
  })

  it("équipe absente, inactive, étrangère, non courante ou dirigée par un autre employé : 404", () => {
    const invalidTeams: MileageAccessContext["team"][] = [
      null,
      { ...context().team!, active: false },
      { ...context().team!, companyId: "company-B" },
      { ...context().team!, id: "previous-team" },
      { ...context().team!, leaderId: "another-employee" },
    ]
    for (const team of invalidTeams) {
      for (const action of ["READ", "START", "END"] as const) {
        rejects(() => assertMileageAccess(action, { ...context(), team }), "TRUCK_NOT_FOUND", 404)
      }
    }
  })

  it("véhicule sans équipe : aucun droit TL, même s'il a une équipe ailleurs", () => {
    const current = context()
    current.truck.teamId = null
    for (const action of ["READ", "START", "END"] as const) {
      rejects(() => assertMileageAccess(action, current), "TRUCK_NOT_FOUND", 404)
    }
  })

  it("chauffeur, membre ou auteur du trajet n'est pas une autorisation de chef", () => {
    const current = context()
    current.team!.leaderId = "another-employee"
    Object.assign(current.truck, { chauffeurId: current.employee!.id, startedById: current.actor.id })
    Object.assign(current.team!, { memberIds: [current.employee!.id] })
    rejects(() => assertMileageAccess("END", current), "TRUCK_NOT_FOUND", 404)
  })

  it("le chef peut agir sur chaque équipe qu'il dirige, sans dépendre d'une première équipe", () => {
    for (const teamId of ["team-1", "team-2"]) {
      const current = context()
      current.truck.teamId = teamId
      current.team!.id = teamId
      for (const action of ["READ", "START", "END"] as const) {
        assert.doesNotThrow(() => assertMileageAccess(action, current))
      }
    }
  })

  it("après réaffectation l'ancien chef perd accès; le nouveau peut terminer sans être l'auteur", () => {
    const previousLeader = context()
    assert.doesNotThrow(() => assertMileageAccess("END", previousLeader))
    previousLeader.truck.teamId = "team-2"
    previousLeader.team = { id: "team-2", companyId: COMPANY, leaderId: "employee-new", active: true }
    Object.assign(previousLeader.truck, { startedById: previousLeader.actor.id, departureTeamId: "team-1" })
    const newLeader: MileageAccessContext = {
      ...previousLeader,
      actor: { ...previousLeader.actor, id: "user-new" },
      employee: { id: "employee-new", userId: "user-new", companyId: COMPANY, active: true },
    }
    for (const action of ["READ", "START", "END"] as const) {
      rejects(() => assertMileageAccess(action, previousLeader), "TRUCK_NOT_FOUND", 404)
      assert.doesNotThrow(() => assertMileageAccess(action, newLeader))
    }
  })
})
