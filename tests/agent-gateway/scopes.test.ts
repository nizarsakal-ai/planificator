/**
 * PLAN-AGENT-GATEWAY-001 — LOT-1A — T-SCOPE-MAP-1..4.
 * Correspondance enum Prisma ↔ scopes du contrat (fiche B.3bis).
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { AgentScope } from "@prisma/client"
import {
  AGENT_SCOPE_TO_CONTRACT,
  CONTRACT_SCOPES,
  fromContractScope,
  isContractScope,
  toContractScope,
  toContractScopes,
  UnknownContractScopeError,
} from "@/lib/agent-gateway/scopes"

describe("T-SCOPE-MAP-1 — bijection", () => {
  it("chaque membre de l'enum revient sur lui-même via la chaîne", () => {
    for (const scope of Object.values(AgentScope)) {
      assert.equal(fromContractScope(toContractScope(scope)), scope)
    }
  })
  it("chaque chaîne du contrat revient sur elle-même via l'enum", () => {
    for (const contract of CONTRACT_SCOPES) {
      assert.equal(toContractScope(fromContractScope(contract)), contract)
    }
  })
  it("aucune chaîne dupliquée", () => {
    assert.equal(new Set(CONTRACT_SCOPES).size, CONTRACT_SCOPES.length)
  })
})

describe("T-SCOPE-MAP-2 — exhaustivité (exécution ; la compilation est garantie par `satisfies`)", () => {
  it("l'enum généré et la table ont exactement les mêmes clés", () => {
    const enumKeys = Object.values(AgentScope).sort()
    const tableKeys = Object.keys(AGENT_SCOPE_TO_CONTRACT).sort()
    assert.deepEqual(tableKeys, enumKeys)
    assert.equal(CONTRACT_SCOPES.length, enumKeys.length)
  })
  it("valeurs attendues en v1", () => {
    assert.deepEqual(
      [...CONTRACT_SCOPES].sort(),
      ["absences:read", "assignments:read", "employees:read", "worksites:read"]
    )
  })
})

describe("T-SCOPE-MAP-3 — rejet strict", () => {
  for (const bad of ["worksites:write", "WORKSITES_READ", "", "Worksites:read", " worksites:read", "worksites:read ", "worksites", "*:read"]) {
    it(`${JSON.stringify(bad)} rejeté`, () => {
      assert.throws(() => fromContractScope(bad), (e: unknown) => e instanceof UnknownContractScopeError && e.received === bad)
      assert.equal(isContractScope(bad), false)
    })
  }
  it("isContractScope accepte uniquement les chaînes de la table", () => {
    assert.equal(isContractScope("worksites:read"), true)
    assert.equal(isContractScope(42), false)
    assert.equal(isContractScope(null), false)
  })
})

describe("T-SCOPE-MAP-4 — aucun scope d'écriture en v1", () => {
  it("ni membre *_WRITE ni chaîne *:write", () => {
    assert.equal(Object.values(AgentScope).some((s) => /WRITE/.test(s)), false)
    assert.equal(CONTRACT_SCOPES.some((s) => s.endsWith(":write")), false)
    assert.equal(CONTRACT_SCOPES.every((s) => s.endsWith(":read")), true)
  })
  it("toContractScopes conserve l'ordre", () => {
    assert.deepEqual(toContractScopes([AgentScope.ABSENCES_READ, AgentScope.WORKSITES_READ]), ["absences:read", "worksites:read"])
  })
})
