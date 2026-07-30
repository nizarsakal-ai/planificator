/**
 * PLAN-ACQ-V2 Lot I — Tests resolver multi-partenaires.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { PartnerEligibilityResolver } from "@/lib/acquisition/partner-eligibility.resolver"
import type {
  AcquisitionPartnerRecord,
  AcquisitionPartnerDomainRecord,
  AcquisitionPartnerEmailRecord,
  PartnerRegistryRepositoryPort,
} from "@/lib/acquisition/persistence/partner-registry.repository"

function partner(
  overrides: Partial<AcquisitionPartnerRecord> & Pick<AcquisitionPartnerRecord, "id" | "code">
): AcquisitionPartnerRecord {
  return {
    companyId: "co",
    name: overrides.code,
    connector: "GMAIL",
    pipeline: "consultations",
    active: true,
    priority: 100,
    requireExactEmail: false,
    autoApproveEnabled: false,
    autoConvertEnabled: false,
    minConfidence: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
    allowCreateClient: overrides.allowCreateClient ?? false,
  }
}

function fakeRegistry(opts: {
  byDomain?: Map<string, ReturnType<typeof partner> & { domain: AcquisitionPartnerDomainRecord }>
  byEmail?: Map<string, ReturnType<typeof partner> & { email: AcquisitionPartnerEmailRecord }>
}): PartnerRegistryRepositoryPort {
  return {
    findPartnerByCode: async () => null,
    findPartnerById: async () => null,
    findPartnerByDomain: async (_c, domain) => opts.byDomain?.get(domain) ?? null,
    findPartnerByEmail: async (_c, email) => opts.byEmail?.get(email) ?? null,
    findDomain: async () => null,
    listPartners: async () => [],
    listDomains: async () => [],
    listEmails: async () => [],
    partnerExists: async () => false,
    domainExists: async () => false,
  }
}

describe("PartnerEligibilityResolver Lot I", () => {
  it("domaine actif → éligible DOMAIN", async () => {
    const p = partner({ id: "p1", code: "acme" })
    const resolver = new PartnerEligibilityResolver(
      fakeRegistry({
        byDomain: new Map([
          [
            "acme.fr",
            {
              ...p,
              domain: {
                id: "d1",
                companyId: "co",
                partnerId: "p1",
                domainNormalized: "acme.fr",
                active: true,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            },
          ],
        ]),
      })
    )
    const r = await resolver.resolveEligibleSender("co", "a@acme.fr", "acme.fr")
    assert.equal(r?.matchKind, "DOMAIN")
    assert.equal(r?.partner.code, "acme")
  })

  it("email exact → prioritaire sur domaine", async () => {
    const pEmail = partner({ id: "p-email", code: "vip" })
    const pDomain = partner({ id: "p-dom", code: "acme" })
    const resolver = new PartnerEligibilityResolver(
      fakeRegistry({
        byEmail: new Map([
          [
            "boss@acme.fr",
            {
              ...pEmail,
              email: {
                id: "e1",
                companyId: "co",
                partnerId: "p-email",
                emailNormalized: "boss@acme.fr",
                active: true,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            },
          ],
        ]),
        byDomain: new Map([
          [
            "acme.fr",
            {
              ...pDomain,
              domain: {
                id: "d1",
                companyId: "co",
                partnerId: "p-dom",
                domainNormalized: "acme.fr",
                active: true,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            },
          ],
        ]),
      })
    )
    const r = await resolver.resolveEligibleSender("co", "boss@acme.fr", "acme.fr")
    assert.equal(r?.matchKind, "EMAIL")
    assert.equal(r?.partner.code, "vip")
  })

  it("requireExactEmail sans email → rejeté", async () => {
    const p = partner({ id: "p1", code: "strict", requireExactEmail: true })
    const resolver = new PartnerEligibilityResolver(
      fakeRegistry({
        byDomain: new Map([
          [
            "strict.fr",
            {
              ...p,
              domain: {
                id: "d1",
                companyId: "co",
                partnerId: "p1",
                domainNormalized: "strict.fr",
                active: true,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            },
          ],
        ]),
      })
    )
    const r = await resolver.resolveEligibleSender("co", "x@strict.fr", "strict.fr")
    assert.equal(r, null)
    assert.equal(await resolver.isDomainEligible("co", "strict.fr"), false)
  })
})
