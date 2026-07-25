/**
 * PLAN-ACQ-012-LOT-1.2-R4 — Intégration PostgreSQL bootstrap LAURALU.
 * Skip si TEST_ACQUISITION_DATABASE_URL absent.
 *
 * Prérequis : migration LOT-1.1 appliquée sur la DB de test.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import {
  bootstrapLauraluPartnerRegistry,
  LAURALU_DOMAIN_NORMALIZED,
  LAURALU_PARTNER_CODE,
  type PartnerRegistryBootstrapDb,
  type PartnerRegistryBootstrapTx,
} from "@/lib/acquisition/partner-registry-bootstrap"

const TEST_URL = process.env.TEST_ACQUISITION_DATABASE_URL
const enabled = Boolean(TEST_URL)

const prisma = enabled
  ? new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
  : (null as unknown as PrismaClient)

const RUN = {
  skip: enabled ? undefined : "TEST_ACQUISITION_DATABASE_URL non défini",
}

function asBootstrapDb(client: PrismaClient): PartnerRegistryBootstrapDb {
  return {
    company: client.company,
    acquisitionPartner: client.acquisitionPartner,
    acquisitionPartnerDomain: client.acquisitionPartnerDomain,
    $transaction: (fn) =>
      client.$transaction((tx) => fn(tx as unknown as PartnerRegistryBootstrapTx)),
  }
}

let companyId = ""

describe("partner-registry-bootstrap — intégration PostgreSQL", RUN, () => {
  before(async () => {
    const company = await prisma.company.create({
      data: {
        name: "Bootstrap Concurrent Test",
        slug: `acq-boot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      },
    })
    companyId = company.id
  })

  after(async () => {
    if (companyId) {
      await prisma.acquisitionPartnerDomain.deleteMany({
        where: { companyId },
      })
      await prisma.acquisitionPartner.deleteMany({ where: { companyId } })
      await prisma.company.deleteMany({ where: { id: companyId } })
    }
    await prisma.$disconnect()
  })

  it("deux exécutions concurrentes → 1 partenaire + 1 domaine, pas de faux échec", async () => {
    const db = asBootstrapDb(prisma)

    // Borne le bootstrap à cette Company via un adaptateur findMany.
    const scoped: PartnerRegistryBootstrapDb = {
      ...db,
      company: {
        findMany: async () => [{ id: companyId }],
      },
    }

    const [a, b] = await Promise.all([
      bootstrapLauraluPartnerRegistry(scoped),
      bootstrapLauraluPartnerRegistry(scoped),
    ])

    const failed = [...a.failed, ...b.failed]
    assert.equal(failed.length, 0, `faux échec: ${JSON.stringify(failed)}`)

    const partners = await prisma.acquisitionPartner.findMany({
      where: { companyId, code: LAURALU_PARTNER_CODE },
    })
    const domains = await prisma.acquisitionPartnerDomain.findMany({
      where: { companyId, domainNormalized: LAURALU_DOMAIN_NORMALIZED },
    })

    assert.equal(partners.length, 1)
    assert.equal(domains.length, 1)
    assert.equal(domains[0]!.partnerId, partners[0]!.id)

    // Aucun orphelin : partenaires lauralu sans domaine.
    assert.equal(partners.length, domains.length)

    const successes = a.companiesSucceeded + b.companiesSucceeded
    const concurrents = a.concurrentlyCreated + b.concurrentlyCreated
    const created =
      a.partnersCreated +
      b.partnersCreated +
      a.domainsCreated +
      b.domainsCreated
    assert.ok(
      successes === 2,
      `les deux runs doivent réussir (created/concurrent/already): ${JSON.stringify({ a, b })}`
    )
    assert.ok(
      created > 0 || concurrents > 0 || a.alreadyPresent + b.alreadyPresent > 0
    )

    // Seconde passe séquentielle idempotente.
    const third = await bootstrapLauraluPartnerRegistry(scoped)
    assert.equal(third.alreadyPresent, 1)
    assert.equal(third.partnersCreated, 0)
    assert.equal(third.domainsCreated, 0)
    assert.equal(third.companiesFailed, 0)

    const partnersAfter = await prisma.acquisitionPartner.count({
      where: { companyId, code: LAURALU_PARTNER_CODE },
    })
    const domainsAfter = await prisma.acquisitionPartnerDomain.count({
      where: { companyId, domainNormalized: LAURALU_DOMAIN_NORMALIZED },
    })
    assert.equal(partnersAfter, 1)
    assert.equal(domainsAfter, 1)
  })
})
