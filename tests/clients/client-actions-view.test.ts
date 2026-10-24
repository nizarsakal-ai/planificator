/**
 * Logique pure du menu des actions clients (aucun React, aucune base).
 * Exécution : npm run test:clients
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { canDeleteClient, CLIENT_DELETE_ROLES, getClientMenuActions } from "@/lib/clients/client-actions-view"

describe("canDeleteClient — droits d'affichage alignés sur requireDeleteAdmin", () => {
  it("ADMIN et SUPER_ADMIN peuvent supprimer", () => {
    assert.equal(canDeleteClient("ADMIN"), true)
    assert.equal(canDeleteClient("SUPER_ADMIN"), true)
  })
  it("TEAM_LEADER, EMPLOYEE, CLIENT, null, undefined ne peuvent pas", () => {
    assert.equal(canDeleteClient("TEAM_LEADER"), false)
    assert.equal(canDeleteClient("EMPLOYEE"), false)
    assert.equal(canDeleteClient("CLIENT"), false)
    assert.equal(canDeleteClient(null), false)
    assert.equal(canDeleteClient(undefined), false)
  })
  it("CLIENT_DELETE_ROLES contient exactement ADMIN et SUPER_ADMIN", () => {
    assert.deepEqual([...CLIENT_DELETE_ROLES].sort(), ["ADMIN", "SUPER_ADMIN"])
  })
})

describe("getClientMenuActions — ordre et présence des entrées", () => {
  it("client actif, droit de suppression : Modifier / Désactiver / Supprimer", () => {
    assert.deepEqual(getClientMenuActions(true, true), ["edit", "deactivate", "delete"])
  })
  it("client inactif, droit de suppression : Modifier / Réactiver / Supprimer", () => {
    assert.deepEqual(getClientMenuActions(false, true), ["edit", "reactivate", "delete"])
  })
  it("sans droit de suppression (TEAM_LEADER) : jamais d'entrée Supprimer", () => {
    assert.deepEqual(getClientMenuActions(true, false), ["edit", "deactivate"])
    assert.deepEqual(getClientMenuActions(false, false), ["edit", "reactivate"])
  })
  it("Supprimer est toujours la dernière entrée", () => {
    const actions = getClientMenuActions(true, true)
    assert.equal(actions[actions.length - 1], "delete")
  })
})
