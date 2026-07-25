/**
 * PLAN-ACQ-012-LOT-1.4-R4 — Tests preflight readiness (lecture seule, règle LAURALU exacte).
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  checkAcquisitionPartnerRegistryReadiness,
  READINESS_ERROR,
  readinessExitCode,
  type PartnerRegistryReadinessDb,
} from "@/lib/acquisition/partner-registry-readiness"
import {
  LAURALU_DOMAIN_NORMALIZED,
  LAURALU_PARTNER_CODE,
} from "@/lib/acquisition/partner-registry-bootstrap"

type Partner = {
  id: string
  companyId: string
  code: string
  active: boolean
}

type Domain = {
  id: string
  companyId: string
  partnerId: string
  domainNormalized: string
  active: boolean
}

type WriteOp = "create" | "update" | "delete" | "upsert"

function fakeDb(seed: {
  companies: Array<{ id: string }>
  partners?: Partner[]
  domains?: Domain[]
  throwOnCompanies?: Error
  throwOnCompany?: string
}): PartnerRegistryReadinessDb & { writes: WriteOp[] } {
  const partners = seed.partners ?? []
  const domains = seed.domains ?? []
  const writes: WriteOp[] = []

  return {
    writes,
    company: {
      findMany: async () => {
        if (seed.throwOnCompanies) throw seed.throwOnCompanies
        return seed.companies
      },
    },
    acquisitionPartner: {
      findUnique: async ({ where }) => {
        const { companyId, code } = where.companyId_code
        if (seed.throwOnCompany === companyId) {
          throw Object.assign(new Error("raw prisma secret boom"), { code: "P2024" })
        }
        const row = partners.find((p) => p.companyId === companyId && p.code === code)
        return row
          ? {
              id: row.id,
              companyId: row.companyId,
              code: row.code,
              active: row.active,
            }
          : null
      },
    },
    acquisitionPartnerDomain: {
      findUnique: async ({ where }) => {
        const { companyId, domainNormalized } = where.companyId_domainNormalized
        if (seed.throwOnCompany === companyId) {
          throw Object.assign(new Error("raw prisma secret boom"), { code: "P2024" })
        }
        const row = domains.find(
          (d) => d.companyId === companyId && d.domainNormalized === domainNormalized
        )
        return row
          ? {
              id: row.id,
              companyId: row.companyId,
              partnerId: row.partnerId,
              domainNormalized: row.domainNormalized,
              active: row.active,
            }
          : null
      },
    },
  }
}

function readyPair(companyId: string, partnerId: string, domainId: string) {
  return {
    partner: {
      id: partnerId,
      companyId,
      code: LAURALU_PARTNER_CODE,
      active: true,
    } satisfies Partner,
    domain: {
      id: domainId,
      companyId,
      partnerId,
      domainNormalized: LAURALU_DOMAIN_NORMALIZED,
      active: true,
    } satisfies Domain,
  }
}

describe("checkAcquisitionPartnerRegistryReadiness (R4)", () => {
  it("Company prête : lauralu actif + domaine lié → exit 0", async () => {
    const a = readyPair("c1", "p1", "d1")
    const db = fakeDb({
      companies: [{ id: "c1" }],
      partners: [a.partner],
      domains: [a.domain],
    })
    const report = await checkAcquisitionPartnerRegistryReadiness(db)
    assert.equal(report.companiesTotal, 1)
    assert.equal(report.companiesReady, 1)
    assert.equal(report.companiesNotReady, 0)
    assert.equal(readinessExitCode(report), 0)
    assert.equal(db.writes.length, 0)
  })

  it("partenaire lauralu absent → missingLauraluPartner", async () => {
    const report = await checkAcquisitionPartnerRegistryReadiness(
      fakeDb({ companies: [{ id: "c1" }], partners: [], domains: [] })
    )
    assert.deepEqual(report.missingLauraluPartner, ["c1"])
    assert.deepEqual(report.missingLauraluDomain, ["c1"])
    assert.equal(report.companiesNotReady, 1)
    assert.equal(readinessExitCode(report), 1)
  })

  it("partenaire lauralu inactif → inactiveLauraluPartner", async () => {
    const report = await checkAcquisitionPartnerRegistryReadiness(
      fakeDb({
        companies: [{ id: "c1" }],
        partners: [
          {
            id: "p1",
            companyId: "c1",
            code: LAURALU_PARTNER_CODE,
            active: false,
          },
        ],
        domains: [
          {
            id: "d1",
            companyId: "c1",
            partnerId: "p1",
            domainNormalized: LAURALU_DOMAIN_NORMALIZED,
            active: true,
          },
        ],
      })
    )
    assert.deepEqual(report.inactiveLauraluPartner, ["c1"])
    assert.equal(report.missingLauraluPartner.length, 0)
    assert.equal(report.companiesReady, 0)
    assert.equal(readinessExitCode(report), 1)
  })

  it("domaine lauralu.fr absent → missingLauraluDomain", async () => {
    const report = await checkAcquisitionPartnerRegistryReadiness(
      fakeDb({
        companies: [{ id: "c1" }],
        partners: [
          {
            id: "p1",
            companyId: "c1",
            code: LAURALU_PARTNER_CODE,
            active: true,
          },
        ],
        domains: [],
      })
    )
    assert.deepEqual(report.missingLauraluDomain, ["c1"])
    assert.equal(readinessExitCode(report), 1)
  })

  it("domaine lauralu.fr inactif → inactiveLauraluDomain", async () => {
    const report = await checkAcquisitionPartnerRegistryReadiness(
      fakeDb({
        companies: [{ id: "c1" }],
        partners: [
          {
            id: "p1",
            companyId: "c1",
            code: LAURALU_PARTNER_CODE,
            active: true,
          },
        ],
        domains: [
          {
            id: "d1",
            companyId: "c1",
            partnerId: "p1",
            domainNormalized: LAURALU_DOMAIN_NORMALIZED,
            active: false,
          },
        ],
      })
    )
    assert.deepEqual(report.inactiveLauraluDomain, ["c1"])
    assert.equal(readinessExitCode(report), 1)
  })

  it("domaine lauralu.fr rattaché à un autre partenaire → lauraluDomainLinkedToWrongPartner", async () => {
    const report = await checkAcquisitionPartnerRegistryReadiness(
      fakeDb({
        companies: [{ id: "c1" }],
        partners: [
          {
            id: "p-lauralu",
            companyId: "c1",
            code: LAURALU_PARTNER_CODE,
            active: true,
          },
          {
            id: "p-other",
            companyId: "c1",
            code: "other",
            active: true,
          },
        ],
        domains: [
          {
            id: "d1",
            companyId: "c1",
            partnerId: "p-other",
            domainNormalized: LAURALU_DOMAIN_NORMALIZED,
            active: true,
          },
        ],
      })
    )
    assert.deepEqual(report.lauraluDomainLinkedToWrongPartner, ["c1"])
    assert.equal(report.companiesReady, 0)
    assert.equal(readinessExitCode(report), 1)
  })

  it("plusieurs Companies : mix prêt / non prêt → exit 1, compteurs exacts", async () => {
    const ready = readyPair("c-ok", "p-ok", "d-ok")
    const report = await checkAcquisitionPartnerRegistryReadiness(
      fakeDb({
        companies: [{ id: "c-ok" }, { id: "c-bad" }],
        partners: [ready.partner],
        domains: [ready.domain],
      })
    )
    assert.equal(report.companiesTotal, 2)
    assert.equal(report.companiesReady, 1)
    assert.equal(report.companiesNotReady, 1)
    assert.deepEqual(report.missingLauraluPartner, ["c-bad"])
    assert.equal(readinessExitCode(report), 1)
  })

  it("erreur DB Company → databaseErrors, pas de message brut, exit 1", async () => {
    const report = await checkAcquisitionPartnerRegistryReadiness(
      fakeDb({
        companies: [{ id: "c1" }],
        partners: [],
        domains: [],
        throwOnCompany: "c1",
      })
    )
    assert.equal(report.companiesNotReady, 1)
    assert.deepEqual(report.databaseErrors, [
      { companyId: "c1", code: READINESS_ERROR.COMPANY_LOOKUP_FAILED },
    ])
    const serialized = JSON.stringify(report)
    assert.equal(serialized.includes("secret"), false)
    assert.equal(serialized.includes("boom"), false)
    assert.equal(serialized.includes("P2024"), false)
    assert.equal(readinessExitCode(report), 1)
  })

  it("zéro Company → NO_COMPANIES_FOUND, exit 1", async () => {
    const report = await checkAcquisitionPartnerRegistryReadiness(
      fakeDb({ companies: [] })
    )
    assert.equal(report.companiesTotal, 0)
    assert.equal(report.companiesReady, 0)
    assert.equal(report.companiesNotReady, 0)
    assert.deepEqual(report.databaseErrors, [
      { companyId: null, code: READINESS_ERROR.NO_COMPANIES_FOUND },
    ])
    assert.equal(readinessExitCode(report), 1)
  })

  it("même domaine dans plusieurs tenants : résolution indépendante", async () => {
    const a = readyPair("co_a", "pa", "da")
    const bPartnerInactive = {
      id: "pb",
      companyId: "co_b",
      code: LAURALU_PARTNER_CODE,
      active: false,
    }
    const bDomain = {
      id: "db",
      companyId: "co_b",
      partnerId: "pb",
      domainNormalized: LAURALU_DOMAIN_NORMALIZED,
      active: true,
    }
    const report = await checkAcquisitionPartnerRegistryReadiness(
      fakeDb({
        companies: [{ id: "co_a" }, { id: "co_b" }],
        partners: [a.partner, bPartnerInactive],
        domains: [a.domain, bDomain],
      })
    )
    assert.equal(report.companiesReady, 1)
    assert.equal(report.companiesNotReady, 1)
    assert.deepEqual(report.inactiveLauraluPartner, ["co_b"])
    assert.equal(report.missingLauraluPartner.includes("co_a"), false)
    assert.equal(readinessExitCode(report), 1)
  })

  it("aucune écriture (create/update/delete/upsert) sur le chemin readiness", async () => {
    const a = readyPair("c1", "p1", "d1")
    const db = fakeDb({
      companies: [{ id: "c1" }],
      partners: [a.partner],
      domains: [a.domain],
    })
    await checkAcquisitionPartnerRegistryReadiness(db)
    assert.deepEqual(db.writes, [])
    assert.equal("create" in db.company, false)
    assert.equal("create" in db.acquisitionPartner, false)
    assert.equal("create" in db.acquisitionPartnerDomain, false)
  })

  it("tables inaccessibles → TABLES_INACCESSIBLE, exit 1, sans fuite", async () => {
    const report = await checkAcquisitionPartnerRegistryReadiness(
      fakeDb({
        companies: [],
        throwOnCompanies: Object.assign(new Error("secret table missing"), {
          code: "P2021",
        }),
      })
    )
    assert.deepEqual(report.databaseErrors, [
      { companyId: null, code: READINESS_ERROR.TABLES_INACCESSIBLE },
    ])
    assert.equal(JSON.stringify(report).includes("secret"), false)
    assert.equal(readinessExitCode(report), 1)
  })
})
