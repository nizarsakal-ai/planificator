/**
 * PLAN-ACQ-012-LOT-1.4 — Tests PartnerEligibilityResolver.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { PartnerEligibilityResolver } from "@/lib/acquisition/partner-eligibility.resolver"
import type {
  AcquisitionPartnerDomainRecord,
  AcquisitionPartnerRecord,
  AcquisitionPartnerWithDomainRecord,
  PartnerRegistryRepositoryPort,
} from "@/lib/acquisition/persistence/partner-registry.repository"

const now = new Date("2026-07-25T12:00:00.000Z")

function partner(
  partial: Partial<AcquisitionPartnerRecord> &
    Pick<AcquisitionPartnerRecord, "id" | "companyId" | "code" | "active">
): AcquisitionPartnerRecord {
  return {
    name: "P",
    connector: "GMAIL",
    pipeline: "consultations",
    createdAt: now,
    updatedAt: now,
    ...partial,
  }
}

function domain(
  partial: Partial<AcquisitionPartnerDomainRecord> &
    Pick<
      AcquisitionPartnerDomainRecord,
      "id" | "companyId" | "partnerId" | "domainNormalized" | "active"
    >
): AcquisitionPartnerDomainRecord {
  return {
    createdAt: now,
    updatedAt: now,
    ...partial,
  }
}

function fakeRegistry(
  hits: Map<string, AcquisitionPartnerWithDomainRecord | null>,
  options?: { throwOnFind?: Error }
): PartnerRegistryRepositoryPort {
  return {
    findPartnerByCode: async () => null,
    findPartnerByDomain: async (companyId, domainName) => {
      if (options?.throwOnFind) throw options.throwOnFind
      const key = `${companyId}::${domainName.trim().toLowerCase()}`
      return hits.has(key) ? hits.get(key)! : null
    },
    findDomain: async () => null,
    listPartners: async () => [],
    listDomains: async () => [],
    partnerExists: async () => false,
    domainExists: async () => false,
  }
}

function hit(
  p: AcquisitionPartnerRecord,
  d: AcquisitionPartnerDomainRecord
): AcquisitionPartnerWithDomainRecord {
  return { ...p, domain: d }
}

describe("PartnerEligibilityResolver", () => {
  it("accepte partenaire actif + domaine actif", async () => {
    const p = partner({ id: "p1", companyId: "co_a", code: "lauralu", active: true })
    const d = domain({
      id: "d1",
      companyId: "co_a",
      partnerId: "p1",
      domainNormalized: "lauralu.fr",
      active: true,
    })
    const resolver = new PartnerEligibilityResolver(
      fakeRegistry(new Map([["co_a::lauralu.fr", hit(p, d)]]))
    )
    assert.equal(await resolver.isDomainEligible("co_a", "lauralu.fr"), true)
  })

  it("rejette partenaire inactif", async () => {
    const p = partner({ id: "p1", companyId: "co_a", code: "lauralu", active: false })
    const d = domain({
      id: "d1",
      companyId: "co_a",
      partnerId: "p1",
      domainNormalized: "lauralu.fr",
      active: true,
    })
    const resolver = new PartnerEligibilityResolver(
      fakeRegistry(new Map([["co_a::lauralu.fr", hit(p, d)]]))
    )
    assert.equal(await resolver.isDomainEligible("co_a", "lauralu.fr"), false)
  })

  it("rejette domaine inactif", async () => {
    const p = partner({ id: "p1", companyId: "co_a", code: "lauralu", active: true })
    const d = domain({
      id: "d1",
      companyId: "co_a",
      partnerId: "p1",
      domainNormalized: "lauralu.fr",
      active: false,
    })
    const resolver = new PartnerEligibilityResolver(
      fakeRegistry(new Map([["co_a::lauralu.fr", hit(p, d)]]))
    )
    assert.equal(await resolver.isDomainEligible("co_a", "lauralu.fr"), false)
  })

  it("rejette domaine absent", async () => {
    const resolver = new PartnerEligibilityResolver(fakeRegistry(new Map()))
    assert.equal(await resolver.isDomainEligible("co_a", "missing.fr"), false)
  })

  it("rejette partenaire absent (pas de hit registre)", async () => {
    const resolver = new PartnerEligibilityResolver(fakeRegistry(new Map()))
    assert.equal(await resolver.isDomainEligible("co_a", "lauralu.fr"), false)
  })

  it("plusieurs domaines : seul le domaine demandé compte", async () => {
    const p = partner({ id: "p1", companyId: "co_a", code: "lauralu", active: true })
    const dOk = domain({
      id: "d1",
      companyId: "co_a",
      partnerId: "p1",
      domainNormalized: "lauralu.fr",
      active: true,
    })
    const resolver = new PartnerEligibilityResolver(
      fakeRegistry(
        new Map([
          ["co_a::lauralu.fr", hit(p, dOk)],
          // autre domaine non interrogé
        ])
      )
    )
    assert.equal(await resolver.isDomainEligible("co_a", "lauralu.fr"), true)
    assert.equal(await resolver.isDomainEligible("co_a", "other.fr"), false)
  })

  it("plusieurs partenaires : isolation par domaine", async () => {
    const p1 = partner({ id: "p1", companyId: "co_a", code: "lauralu", active: true })
    const p2 = partner({ id: "p2", companyId: "co_a", code: "other", active: false })
    const d1 = domain({
      id: "d1",
      companyId: "co_a",
      partnerId: "p1",
      domainNormalized: "lauralu.fr",
      active: true,
    })
    const d2 = domain({
      id: "d2",
      companyId: "co_a",
      partnerId: "p2",
      domainNormalized: "other.fr",
      active: true,
    })
    const resolver = new PartnerEligibilityResolver(
      fakeRegistry(
        new Map([
          ["co_a::lauralu.fr", hit(p1, d1)],
          ["co_a::other.fr", hit(p2, d2)],
        ])
      )
    )
    assert.equal(await resolver.isDomainEligible("co_a", "lauralu.fr"), true)
    assert.equal(await resolver.isDomainEligible("co_a", "other.fr"), false)
  })

  it("isolation multi-tenant", async () => {
    const pA = partner({ id: "pa", companyId: "co_a", code: "lauralu", active: true })
    const dA = domain({
      id: "da",
      companyId: "co_a",
      partnerId: "pa",
      domainNormalized: "lauralu.fr",
      active: true,
    })
    const resolver = new PartnerEligibilityResolver(
      fakeRegistry(new Map([["co_a::lauralu.fr", hit(pA, dA)]]))
    )
    assert.equal(await resolver.isDomainEligible("co_a", "lauralu.fr"), true)
    assert.equal(await resolver.isDomainEligible("co_b", "lauralu.fr"), false)
  })

  it("propage les erreurs Prisma (pas de masquage)", async () => {
    const err = Object.assign(new Error("db down"), { code: "P1001" })
    const resolver = new PartnerEligibilityResolver(
      fakeRegistry(new Map(), { throwOnFind: err })
    )
    await assert.rejects(
      () => resolver.isDomainEligible("co_a", "lauralu.fr"),
      (e: unknown) => e === err
    )
  })

  it("refuse companyId vide", async () => {
    const resolver = new PartnerEligibilityResolver(fakeRegistry(new Map()))
    await assert.rejects(() => resolver.isDomainEligible("", "lauralu.fr"), {
      message: "companyId requis",
    })
  })
})
