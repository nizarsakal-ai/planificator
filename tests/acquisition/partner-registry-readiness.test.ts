/**
 * PLAN-ACQ-V2 Lot I — Tests readiness multi-partenaires.
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

function fakeDb(seed: {
  companies: Array<{ id: string }>
  partners?: Array<{ id: string; companyId: string; active: boolean }>
  domains?: Array<{ companyId: string; partnerId: string; active: boolean }>
  emails?: Array<{ companyId: string; partnerId: string; active: boolean }>
  throwOnCompanies?: Error
}): PartnerRegistryReadinessDb {
  const partners = seed.partners ?? []
  const domains = seed.domains ?? []
  const emails = seed.emails ?? []
  return {
    company: {
      findMany: async () => {
        if (seed.throwOnCompanies) throw seed.throwOnCompanies
        return seed.companies
      },
    },
    acquisitionPartner: {
      findMany: async ({ where }) =>
        partners
          .filter((p) => p.companyId === where.companyId && p.active === where.active)
          .map((p) => ({ id: p.id })),
    },
    acquisitionPartnerDomain: {
      count: async ({ where }) =>
        domains.filter(
          (d) =>
            d.companyId === where.companyId &&
            d.active === where.active &&
            where.partnerId.in.includes(d.partnerId)
        ).length,
    },
    acquisitionPartnerEmail: {
      count: async ({ where }) =>
        emails.filter(
          (e) =>
            e.companyId === where.companyId &&
            e.active === where.active &&
            where.partnerId.in.includes(e.partnerId)
        ).length,
    },
  }
}

describe("partner-registry-readiness multi-partenaires", () => {
  it("zéro company → NO_COMPANIES_FOUND exit 1", async () => {
    const report = await checkAcquisitionPartnerRegistryReadiness(
      fakeDb({ companies: [] })
    )
    assert.equal(report.companiesTotal, 0)
    assert.ok(
      report.databaseErrors.some((e) => e.code === READINESS_ERROR.NO_COMPANIES_FOUND)
    )
    assert.equal(readinessExitCode(report), 1)
  })

  it("partenaire actif + domaine actif → ready (pas besoin lauralu)", async () => {
    const report = await checkAcquisitionPartnerRegistryReadiness(
      fakeDb({
        companies: [{ id: "c1" }],
        partners: [{ id: "p-acme", companyId: "c1", active: true }],
        domains: [{ companyId: "c1", partnerId: "p-acme", active: true }],
      })
    )
    assert.equal(report.companiesReady, 1)
    assert.equal(readinessExitCode(report), 0)
  })

  it("partenaire actif + email seul → ready", async () => {
    const report = await checkAcquisitionPartnerRegistryReadiness(
      fakeDb({
        companies: [{ id: "c1" }],
        partners: [{ id: "p1", companyId: "c1", active: true }],
        emails: [{ companyId: "c1", partnerId: "p1", active: true }],
      })
    )
    assert.equal(report.companiesReady, 1)
    assert.equal(readinessExitCode(report), 0)
  })

  it("aucun partenaire actif → not ready", async () => {
    const report = await checkAcquisitionPartnerRegistryReadiness(
      fakeDb({
        companies: [{ id: "c1" }],
        partners: [{ id: "p1", companyId: "c1", active: false }],
      })
    )
    assert.deepEqual(report.missingActivePartner, ["c1"])
    assert.equal(readinessExitCode(report), 1)
  })

  it("partenaire sans identité → not ready", async () => {
    const report = await checkAcquisitionPartnerRegistryReadiness(
      fakeDb({
        companies: [{ id: "c1" }],
        partners: [{ id: "p1", companyId: "c1", active: true }],
      })
    )
    assert.deepEqual(report.missingActiveIdentity, ["c1"])
    assert.equal(readinessExitCode(report), 1)
  })
})
