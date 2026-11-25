/**
 * LOT-2 — référence de parité indépendante sous LOT-3 : règles historiques évaluées en lecture seule.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { evaluateLegacyEligibilityReference } from "@/lib/acquisition/admission/legacy-eligibility-reference"
import { PartnerEligibilityResolver } from "@/lib/acquisition/partner-eligibility.resolver"
import type { PartnerRegistryRepositoryPort } from "@/lib/acquisition/persistence/partner-registry.repository"

type Hit = { active: boolean; requireExactEmail: boolean; domain?: { active: boolean }; email?: { active: boolean } }

/** Registre en mémoire : seules les lectures utilisées par le résolveur sont fournies ; toute écriture échouerait. */
function registry(byEmail: Record<string, Hit>, byDomain: Record<string, Hit>, calls: string[] = []): PartnerRegistryRepositoryPort {
  const partner = (h: Hit) => ({ id: "p", name: "Partenaire fictif", ...h }) as never
  return new Proxy({} as PartnerRegistryRepositoryPort, {
    get: (_t, prop) => {
      if (prop === "findPartnerByEmail") return async (_c: string, e: string) => { calls.push(`email:${e}`); return byEmail[e] ? partner(byEmail[e]) : null }
      if (prop === "findPartnerByDomain") return async (_c: string, d: string) => { calls.push(`domain:${d}`); return byDomain[d] ? partner(byDomain[d]) : null }
      return () => { throw new Error(`écriture interdite : ${String(prop)}`) }
    },
  })
}
const on = { active: true }

describe("evaluateLegacyEligibilityReference", () => {
  it("domaine actif → DRAFT_CREATED ; expéditeur normalisé (nom affiché, casse)", async () => {
    const calls: string[] = []
    const reader = new PartnerEligibilityResolver(registry({}, { "partenaire.example": { active: true, requireExactEmail: false, domain: on } }, calls))
    assert.equal(await evaluateLegacyEligibilityReference("c1", '"Devis" <Devis@PARTENAIRE.example>', reader), "DRAFT_CREATED")
    assert.deepEqual(calls, ["email:devis@partenaire.example", "domain:partenaire.example"])
  })
  it("email exact requis : domaine seul → REJECTED ; email exact actif → DRAFT_CREATED", async () => {
    const exact = { active: true, requireExactEmail: true, domain: on, email: on }
    const reader = new PartnerEligibilityResolver(registry({ "devis@exacte.example": exact }, { "exacte.example": exact }))
    assert.equal(await evaluateLegacyEligibilityReference("c1", "autre@exacte.example", reader), "REJECTED")
    assert.equal(await evaluateLegacyEligibilityReference("c1", "devis@exacte.example", reader), "DRAFT_CREATED")
  })
  it("partenaire ou domaine inactif, inconnu → REJECTED", async () => {
    const reader = new PartnerEligibilityResolver(registry({}, {
      "inactif.example": { active: false, requireExactEmail: false, domain: on },
      "domaine-off.example": { active: true, requireExactEmail: false, domain: { active: false } },
    }))
    for (const s of ["a@inactif.example", "a@domaine-off.example", "a@inconnu.example"]) {
      assert.equal(await evaluateLegacyEligibilityReference("c1", s, reader), "REJECTED", s)
    }
  })
  it("expéditeur invalide → REJECTED sans lecture du registre", async () => {
    const calls: string[] = []
    const reader = new PartnerEligibilityResolver(registry({}, {}, calls))
    assert.equal(await evaluateLegacyEligibilityReference("c1", "pas une adresse", reader), "REJECTED")
    assert.deepEqual(calls, [])
  })
})
