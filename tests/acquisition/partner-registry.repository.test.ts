/**
 * PLAN-ACQ-012-LOT-1.3 — Tests PartnerRegistryRepository (fake Prisma, hors runtime).
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  PartnerRegistryRepository,
  normalizeDomainLookup,
  type AcquisitionPartnerDomainRecord,
  type AcquisitionPartnerRecord,
} from "@/lib/acquisition/persistence/partner-registry.repository"

type PartnerRow = AcquisitionPartnerRecord
type DomainRow = AcquisitionPartnerDomainRecord & {
  partner?: PartnerRow
}

function createFakeDb(seed: {
  partners: PartnerRow[]
  domains: DomainRow[]
}) {
  const partners = seed.partners.map((p) => ({ ...p }))
  const domains = seed.domains.map((d) => ({ ...d }))
  const calls: { model: string; where: unknown }[] = []

  const db = {
    acquisitionPartner: {
      findUnique: async ({
        where,
      }: {
        where: { companyId_code: { companyId: string; code: string } }
      }) => {
        calls.push({ model: "partner", where })
        const { companyId, code } = where.companyId_code
        const hit = partners.find(
          (p) => p.companyId === companyId && p.code === code
        )
        return hit ? { ...hit } : null
      },
      findFirst: async ({
        where,
      }: {
        where: { id: string; companyId: string }
      }) => {
        calls.push({ model: "partner.first", where })
        const hit = partners.find(
          (p) => p.id === where.id && p.companyId === where.companyId
        )
        return hit ? { ...hit } : null
      },
      findMany: async ({
        where,
      }: {
        where: { companyId: string }
        orderBy?: unknown
      }) => {
        calls.push({ model: "partner.list", where })
        return partners
          .filter((p) => p.companyId === where.companyId)
          .map((p) => ({ ...p }))
          .sort(
            (a, b) =>
              a.priority - b.priority ||
              a.code.localeCompare(b.code) ||
              a.id.localeCompare(b.id)
          )
      },
    },
    acquisitionPartnerDomain: {
      findUnique: async ({
        where,
        include,
      }: {
        where: {
          companyId_domainNormalized: {
            companyId: string
            domainNormalized: string
          }
        }
        include?: { partner: true }
      }) => {
        calls.push({ model: "domain", where })
        const { companyId, domainNormalized } = where.companyId_domainNormalized
        const hit = domains.find(
          (d) =>
            d.companyId === companyId && d.domainNormalized === domainNormalized
        )
        if (!hit) return null
        if (include?.partner) {
          const partner = partners.find((p) => p.id === hit.partnerId)
          if (!partner) return null
          return { ...hit, partner: { ...partner } }
        }
        return { ...hit }
      },
      findMany: async ({
        where,
      }: {
        where: { companyId: string; partnerId?: string }
        orderBy?: unknown
      }) => {
        calls.push({ model: "domain.list", where })
        return domains
          .filter((d) => {
            if (d.companyId !== where.companyId) return false
            if (where.partnerId && d.partnerId !== where.partnerId) return false
            return true
          })
          .map((d) => ({ ...d }))
          .sort(
            (a, b) =>
              a.domainNormalized.localeCompare(b.domainNormalized) ||
              a.id.localeCompare(b.id)
          )
      },
    },
    acquisitionPartnerEmail: {
      findUnique: async () => null,
      findMany: async () => [],
    },
  }

  return { db, partners, domains, calls }
}

const now = new Date("2026-07-25T12:00:00.000Z")

function partner(
  partial: Partial<PartnerRow> & Pick<PartnerRow, "id" | "companyId" | "code">
): PartnerRow {
  return {
    name: partial.name ?? "LAURALU",
    connector: partial.connector ?? "GMAIL",
    pipeline: partial.pipeline ?? "consultations",
    active: partial.active ?? true,
    priority: partial.priority ?? 100,
    requireExactEmail: partial.requireExactEmail ?? false,
    autoApproveEnabled: partial.autoApproveEnabled ?? false,
    autoConvertEnabled: partial.autoConvertEnabled ?? false,
    minConfidence: partial.minConfidence ?? null,
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
    ...partial,
    allowCreateClient: partial.allowCreateClient ?? false,
  }
}

function domain(
  partial: Partial<DomainRow> &
    Pick<DomainRow, "id" | "companyId" | "partnerId" | "domainNormalized">
): DomainRow {
  return {
    active: partial.active ?? true,
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
    ...partial,
  }
}

describe("normalizeDomainLookup", () => {
  it("applique trim + lowercase uniquement", () => {
    assert.equal(normalizeDomainLookup("  LAURALU.FR  "), "lauralu.fr")
    assert.equal(normalizeDomainLookup("lauralu.fr"), "lauralu.fr")
  })
})

describe("PartnerRegistryRepository", () => {
  const lauralu = partner({
    id: "p_lauralu",
    companyId: "co_a",
    code: "lauralu",
    name: "LAURALU",
  })
  const other = partner({
    id: "p_other",
    companyId: "co_a",
    code: "other",
    name: "OTHER",
  })
  const foreign = partner({
    id: "p_foreign",
    companyId: "co_b",
    code: "lauralu",
    name: "LAURALU B",
  })

  const d1 = domain({
    id: "d1",
    companyId: "co_a",
    partnerId: "p_lauralu",
    domainNormalized: "lauralu.fr",
  })
  const d2 = domain({
    id: "d2",
    companyId: "co_a",
    partnerId: "p_lauralu",
    domainNormalized: "mail.lauralu.example",
  })
  const dOther = domain({
    id: "d3",
    companyId: "co_a",
    partnerId: "p_other",
    domainNormalized: "other.fr",
  })
  const dForeign = domain({
    id: "d4",
    companyId: "co_b",
    partnerId: "p_foreign",
    domainNormalized: "lauralu.fr",
  })

  function repo() {
    const fake = createFakeDb({
      partners: [lauralu, other, foreign],
      domains: [d1, d2, dOther, dForeign],
    })
    return {
      repository: new PartnerRegistryRepository(fake.db as never),
      fake,
    }
  }

  it("partenaire trouvé par code", async () => {
    const { repository } = repo()
    const row = await repository.findPartnerByCode("co_a", "lauralu")
    assert.equal(row?.id, "p_lauralu")
    assert.equal(row?.code, "lauralu")
  })

  it("partenaire absent / code inconnu", async () => {
    const { repository } = repo()
    assert.equal(await repository.findPartnerByCode("co_a", "unknown"), null)
    assert.equal(await repository.partnerExists("co_a", "unknown"), false)
  })

  it("domaine trouvé", async () => {
    const { repository } = repo()
    const row = await repository.findDomain("co_a", "lauralu.fr")
    assert.equal(row?.id, "d1")
    assert.equal(row?.partnerId, "p_lauralu")
  })

  it("domaine absent / inconnu", async () => {
    const { repository } = repo()
    assert.equal(await repository.findDomain("co_a", "missing.fr"), null)
    assert.equal(await repository.domainExists("co_a", "missing.fr"), false)
  })

  it("normalise trim sur lookup domaine", async () => {
    const { repository, fake } = repo()
    const row = await repository.findDomain("co_a", "  lauralu.fr  ")
    assert.equal(row?.id, "d1")
    assert.deepEqual(fake.calls[0]?.where, {
      companyId_domainNormalized: {
        companyId: "co_a",
        domainNormalized: "lauralu.fr",
      },
    })
  })

  it("normalise lowercase sur lookup domaine", async () => {
    const { repository } = repo()
    const row = await repository.findPartnerByDomain("co_a", "LAURALU.FR")
    assert.equal(row?.id, "p_lauralu")
    assert.equal(row?.domain.domainNormalized, "lauralu.fr")
  })

  it("isolation multi-tenant : même code/domaine, autre company", async () => {
    const { repository } = repo()
    const a = await repository.findPartnerByCode("co_a", "lauralu")
    const b = await repository.findPartnerByCode("co_b", "lauralu")
    assert.equal(a?.id, "p_lauralu")
    assert.equal(b?.id, "p_foreign")
    assert.notEqual(a?.id, b?.id)

    const domainA = await repository.findDomain("co_a", "lauralu.fr")
    const domainB = await repository.findDomain("co_b", "lauralu.fr")
    assert.equal(domainA?.id, "d1")
    assert.equal(domainB?.id, "d4")

    const listA = await repository.listPartners("co_a")
    assert.equal(listA.every((p) => p.companyId === "co_a"), true)
    assert.equal(listA.some((p) => p.companyId === "co_b"), false)
  })

  it("plusieurs domaines pour un partenaire", async () => {
    const { repository } = repo()
    const domains = await repository.listDomains("co_a", "p_lauralu")
    assert.equal(domains.length, 2)
    assert.deepEqual(
      domains.map((d) => d.domainNormalized),
      ["lauralu.fr", "mail.lauralu.example"]
    )
  })

  it("plusieurs partenaires dans une même Company", async () => {
    const { repository } = repo()
    const partners = await repository.listPartners("co_a")
    assert.equal(partners.length, 2)
    assert.deepEqual(
      partners.map((p) => p.code),
      ["lauralu", "other"]
    )
  })

  it("listDomains sans partnerId reste scopé company", async () => {
    const { repository } = repo()
    const domains = await repository.listDomains("co_a")
    assert.equal(domains.length, 3)
    assert.equal(domains.every((d) => d.companyId === "co_a"), true)
  })

  it("partnerExists / domainExists", async () => {
    const { repository } = repo()
    assert.equal(await repository.partnerExists("co_a", "lauralu"), true)
    assert.equal(await repository.domainExists("co_a", "OTHER.FR"), true)
  })

  it("refuse companyId vide", async () => {
    const { repository } = repo()
    await assert.rejects(() => repository.findPartnerByCode("", "lauralu"), {
      message: "companyId requis",
    })
    await assert.rejects(() => repository.listPartners(""), {
      message: "companyId requis",
    })
  })

  it("ne mute pas les enregistrements stockés", async () => {
    const { repository, fake } = repo()
    await repository.findDomain("co_a", "  LAURALU.FR ")
    assert.equal(fake.domains[0]!.domainNormalized, "lauralu.fr")
    assert.equal(
      fake.domains.some((d) => d.domainNormalized === "  LAURALU.FR "),
      false
    )
  })
})
