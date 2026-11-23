/** Lot D Planificator V2 : règles pures de la recherche globale (normalisation, groupes autorisés, liens). Aucun groupe RH. */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { GROUP_LABEL, GROUP_ORDER, allowedGroups, hrefFor, normalizeQuery } from "@/lib/search/search.core"
import { isGlobalSearchEnabled } from "@/lib/search/search-feature-flag"

describe("recherche : règles pures", () => {
  it("normalisation : espaces réduits, contrôle et jokers retirés, 2 à 64 caractères", () => {
    assert.equal(normalizeQuery("  Maison   Durand "), "Maison Durand")
    assert.equal(normalizeQuery("a"), null)
    assert.equal(normalizeQuery("%_\\"), null)
    assert.equal(normalizeQuery("ab\u0000cd"), "ab cd")
    assert.equal(normalizeQuery("x".repeat(300))?.length, 64)
    assert.equal(normalizeQuery(null), null)
  })
  it("groupes : ADMIN et SUPER_ADMIN seulement ; chaque module suit son drapeau", () => {
    assert.deepEqual(allowedGroups("ADMIN", { billing: false, equipment: false, reserves: false }), ["worksites", "clients", "articles"])
    assert.deepEqual(allowedGroups("SUPER_ADMIN", { billing: true, equipment: true, reserves: true }), ["worksites", "clients", "quotes", "invoices", "articles", "equipment", "reserves"])
    for (const role of ["TEAM_LEADER", "EMPLOYEE", "CLIENT", null, undefined]) assert.deepEqual(allowedGroups(role, { billing: true, equipment: true, reserves: true }), [], String(role))
  })
  it("aucune donnée RH : pas de groupe ni de lien vers les salariés", () => {
    assert.equal((GROUP_ORDER as readonly string[]).includes("employees"), false)
    assert.equal(Object.keys(GROUP_LABEL).includes("employees"), false)
    for (const g of GROUP_ORDER) assert.doesNotMatch(hrefFor(g, "x1", { worksiteId: "w1" }), /employes|rh/, g)
  })
  it("liens : identifiant contrôlé, jamais de saisie dans le chemin", () => {
    assert.equal(hrefFor("worksites", "w1"), "/chantiers/w1")
    assert.equal(hrefFor("quotes", "../../x"), "/devis/")
    assert.equal(hrefFor("reserves", "r1", { worksiteId: "w9" }), "/reserves/w9")
    assert.equal(hrefFor("reserves", "r1", { worksiteId: "//evil" }), "/reserves")
    assert.equal(hrefFor("clients", "c1"), "/clients")
  })
  it("drapeau : \"true\" exact seulement", () => {
    for (const v of [undefined, "", "TRUE", "1"]) assert.equal(isGlobalSearchEnabled({ GLOBAL_SEARCH_ENABLED: v }), false)
    assert.equal(isGlobalSearchEnabled({ GLOBAL_SEARCH_ENABLED: "true" }), true)
  })
})
