/**
 * PLAN-ACQ-012-LOT-1.2-R4 — Tests unitaires bootstrap.
 * Fake fidèle à PostgreSQL : après P2002, le client `tx` est aborted ;
 * la relecture racine reste possible ; rollback local + commits externes.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  BOOTSTRAP_ERROR,
  bootstrapExitCode,
  bootstrapLauraluPartnerRegistry,
  isUniqueConstraintError,
  LAURALU_DOMAIN_NORMALIZED,
  LAURALU_PARTNER_CODE,
  LAURALU_PARTNER_PIPELINE,
  type PartnerRegistryBootstrapDb,
  type PartnerRegistryBootstrapTx,
} from "@/lib/acquisition/partner-registry-bootstrap"

type Partner = {
  id: string
  companyId: string
  name: string
  code: string
  connector: "GMAIL"
  pipeline: string
  active: boolean
}

type Domain = {
  id: string
  companyId: string
  partnerId: string
  domainNormalized: string
  active: boolean
}

type Company = { id: string; name: string }

function p2002(): Error & { code: string } {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
}

function abortedTxError(): Error & { code: string } {
  return Object.assign(
    new Error("Transaction aborted — queries ignored until rollback"),
    { code: "P2028" }
  )
}

function createPgLikeFake(
  seed: {
    companies: Company[]
    partners?: Partner[]
    domains?: Domain[]
  },
  options: {
    /** P2002 create partenaire + commit externe partenaire+domaine complets. */
    racePartnerComplete?: boolean
    /** P2002 create partenaire + commit externe partenaire seul (incomplet). */
    racePartnerIncompleteOnce?: boolean
    /** P2002 create domaine + commit externe domaine sur partnerId attendu. */
    raceDomainOnExpectedPartner?: boolean
    /** P2002 create domaine + commit externe domaine sur autre partenaire. */
    raceDomainOnOtherPartner?: boolean
    /** P2002 create domaine sans matérialiser (toujours) → retry épuisé. */
    alwaysRaceIncomplete?: boolean
    /** Erreur technique non-P2002 sur create domaine (une fois). */
    domainTechnicalError?: boolean
    beforeDomainCreate?: (ctx: {
      data: { companyId: string; partnerId: string; domainNormalized: string }
    }) => void
  } = {}
) {
  const companies = seed.companies.map((c) => ({ ...c }))
  const partners = (seed.partners ?? []).map((p) => ({ ...p }))
  const domains = (seed.domains ?? []).map((d) => ({ ...d }))
  const writes: { op: string }[] = []
  let seq = 0
  const nextId = (prefix: string) => `${prefix}_${++seq}`

  let partnerRaceBudget = options.racePartnerComplete
    ? 1
    : options.racePartnerIncompleteOnce
      ? 1
      : 0
  let domainRaceBudget = options.raceDomainOnExpectedPartner
    ? 1
    : options.raceDomainOnOtherPartner
      ? 1
      : options.alwaysRaceIncomplete
        ? Number.POSITIVE_INFINITY
        : 0
  let domainTechOnce = Boolean(options.domainTechnicalError)

  const root: PartnerRegistryBootstrapTx = {
    company: {
      findMany: async () =>
        [...companies]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((c) => ({ id: c.id })),
    },
    acquisitionPartner: {
      findUnique: async ({ where }) => {
        const hit = partners.find(
          (p) =>
            p.companyId === where.companyId_code.companyId &&
            p.code === where.companyId_code.code
        )
        return hit
          ? { id: hit.id, companyId: hit.companyId, code: hit.code }
          : null
      },
      create: async ({ data }) => {
        if (
          partners.some(
            (p) => p.companyId === data.companyId && p.code === data.code
          )
        ) {
          throw p2002()
        }
        const row: Partner = {
          id: nextId("partner"),
          companyId: data.companyId,
          name: data.name,
          code: data.code,
          connector: data.connector,
          pipeline: data.pipeline,
          active: data.active,
        }
        partners.push(row)
        writes.push({ op: "create_partner" })
        return { id: row.id, companyId: row.companyId, code: row.code }
      },
    },
    acquisitionPartnerDomain: {
      findUnique: async ({ where }) => {
        const hit = domains.find(
          (d) =>
            d.companyId === where.companyId_domainNormalized.companyId &&
            d.domainNormalized ===
              where.companyId_domainNormalized.domainNormalized
        )
        return hit
          ? {
              id: hit.id,
              companyId: hit.companyId,
              partnerId: hit.partnerId,
              domainNormalized: hit.domainNormalized,
            }
          : null
      },
      create: async ({ data }) => {
        options.beforeDomainCreate?.({ data })
        if (domainTechOnce) {
          domainTechOnce = false
          throw new Error("disk full")
        }
        if (
          domains.some(
            (d) =>
              d.companyId === data.companyId &&
              d.domainNormalized === data.domainNormalized
          )
        ) {
          throw p2002()
        }
        const row: Domain = {
          id: nextId("domain"),
          companyId: data.companyId,
          partnerId: data.partnerId,
          domainNormalized: data.domainNormalized,
          active: data.active,
        }
        domains.push(row)
        writes.push({ op: "create_domain" })
        return {
          id: row.id,
          companyId: row.companyId,
          partnerId: row.partnerId,
          domainNormalized: row.domainNormalized,
        }
      },
    },
  }

  const db: PartnerRegistryBootstrapDb = {
    ...root,
    $transaction: async (fn) => {
      const partnersSnap = partners.map((p) => ({ ...p }))
      const domainsSnap = domains.map((d) => ({ ...d }))
      const writesSnap = writes.length
      let aborted = false
      const external: { partners: Partner[]; domains: Domain[] } = {
        partners: [],
        domains: [],
      }

      const tx: PartnerRegistryBootstrapTx = {
        company: root.company,
        acquisitionPartner: {
          findUnique: async (args) => {
            if (aborted) throw abortedTxError()
            return root.acquisitionPartner.findUnique(args)
          },
          create: async (args) => {
            if (aborted) throw abortedTxError()
            if (partnerRaceBudget > 0) {
              partnerRaceBudget -= 1
              const raced: Partner = {
                id: nextId("raced_partner"),
                companyId: args.data.companyId,
                name: "LAURALU",
                code: args.data.code,
                connector: "GMAIL",
                pipeline: LAURALU_PARTNER_PIPELINE,
                active: true,
              }
              external.partners.push(raced)
              if (options.racePartnerComplete) {
                external.domains.push({
                  id: nextId("raced_domain"),
                  companyId: args.data.companyId,
                  partnerId: raced.id,
                  domainNormalized: LAURALU_DOMAIN_NORMALIZED,
                  active: true,
                })
              }
              aborted = true
              throw p2002()
            }
            try {
              return await root.acquisitionPartner.create(args)
            } catch (e) {
              if (isUniqueConstraintError(e)) aborted = true
              throw e
            }
          },
        },
        acquisitionPartnerDomain: {
          findUnique: async (args) => {
            if (aborted) throw abortedTxError()
            return root.acquisitionPartnerDomain.findUnique(args)
          },
          create: async (args) => {
            if (aborted) throw abortedTxError()
            if (domainRaceBudget > 0) {
              domainRaceBudget -= 1
              if (options.raceDomainOnOtherPartner) {
                const other: Partner = {
                  id: nextId("other_partner"),
                  companyId: args.data.companyId,
                  name: "OTHER",
                  code: "other",
                  connector: "GMAIL",
                  pipeline: LAURALU_PARTNER_PIPELINE,
                  active: true,
                }
                external.partners.push(other)
                external.domains.push({
                  id: nextId("stolen_domain"),
                  companyId: args.data.companyId,
                  partnerId: other.id,
                  domainNormalized: args.data.domainNormalized,
                  active: true,
                })
              } else if (options.raceDomainOnExpectedPartner) {
                // Le partenaire créé dans cette TX doit survivre comme commit
                // ordonné (partenaire puis domaine) côté concurrent.
                const localPartner = partners.find(
                  (p) => p.id === args.data.partnerId
                )
                if (localPartner) {
                  external.partners.push({ ...localPartner })
                }
                external.domains.push({
                  id: nextId("raced_domain"),
                  companyId: args.data.companyId,
                  partnerId: args.data.partnerId,
                  domainNormalized: args.data.domainNormalized,
                  active: true,
                })
              }
              // alwaysRaceIncomplete : P2002 sans matérialiser le domaine.
              aborted = true
              throw p2002()
            }
            try {
              return await root.acquisitionPartnerDomain.create(args)
            } catch (e) {
              if (isUniqueConstraintError(e)) aborted = true
              throw e
            }
          },
        },
      }

      try {
        return await fn(tx)
      } catch (error) {
        partners.splice(0, partners.length, ...partnersSnap)
        domains.splice(0, domains.length, ...domainsSnap)
        writes.splice(writesSnap)
        for (const p of external.partners) {
          if (
            !partners.some(
              (x) => x.companyId === p.companyId && x.code === p.code
            )
          ) {
            partners.push(p)
          }
        }
        for (const d of external.domains) {
          if (
            !domains.some(
              (x) =>
                x.companyId === d.companyId &&
                x.domainNormalized === d.domainNormalized
            )
          ) {
            domains.push(d)
          }
        }
        throw error
      }
    },
  }

  return { db, companies, partners, domains, writes }
}

describe("isUniqueConstraintError", () => {
  it("reconnaît uniquement P2002", () => {
    assert.equal(isUniqueConstraintError({ code: "P2002" }), true)
    assert.equal(isUniqueConstraintError({ code: "P2028" }), false)
  })
})

describe("bootstrapLauraluPartnerRegistry — R4", () => {
  it("première exécution crée partenaire + domaine", async () => {
    const { db, partners, domains } = createPgLikeFake({
      companies: [
        { id: "co_a", name: "A" },
        { id: "co_b", name: "B" },
      ],
    })
    const r = await bootstrapLauraluPartnerRegistry(db)
    assert.equal(r.companiesSucceeded, 2)
    assert.equal(r.partnersCreated, 2)
    assert.equal(r.domainsCreated, 2)
    assert.equal(r.alreadyPresent, 0)
    assert.equal(r.concurrentlyCreated, 0)
    assert.equal(partners.length, 2)
    assert.equal(domains.length, 2)
  })

  it("seconde exécution = alreadyPresent sans concurrentlyCreated", async () => {
    const fake = createPgLikeFake({
      companies: [{ id: "co_1", name: "One" }],
    })
    await bootstrapLauraluPartnerRegistry(fake.db)
    const r = await bootstrapLauraluPartnerRegistry(fake.db)
    assert.equal(r.alreadyPresent, 1)
    assert.equal(r.concurrentlyCreated, 0)
    assert.equal(r.partnersCreated, 0)
  })

  it("1. P2002 partenaire → relecture racine complète → concurrent", async () => {
    const { db, partners, domains } = createPgLikeFake(
      { companies: [{ id: "co_1", name: "One" }] },
      { racePartnerComplete: true }
    )
    const r = await bootstrapLauraluPartnerRegistry(db)
    assert.equal(r.concurrentlyCreated, 1)
    assert.equal(r.alreadyPresent, 0)
    assert.equal(r.partnersCreated, 0)
    assert.equal(partners.length, 1)
    assert.equal(domains.length, 1)
    assert.equal(bootstrapExitCode(r), 0)
  })

  it("2. P2002 domaine → bon partenaire → concurrent", async () => {
    const { db, domains, partners } = createPgLikeFake(
      { companies: [{ id: "co_1", name: "One" }] },
      { raceDomainOnExpectedPartner: true }
    )
    const r = await bootstrapLauraluPartnerRegistry(db)
    assert.equal(r.concurrentlyCreated, 1)
    assert.equal(domains.length, 1)
    assert.equal(domains[0]!.partnerId, partners[0]!.id)
  })

  it("3. P2002 domaine → autre partenaire → conflit + rollback LAURALU", async () => {
    const { db, partners } = createPgLikeFake(
      { companies: [{ id: "co_1", name: "One" }] },
      { raceDomainOnOtherPartner: true }
    )
    const r = await bootstrapLauraluPartnerRegistry(db)
    assert.equal(r.conflicts.length, 1)
    assert.equal(r.conflicts[0]!.reason, BOOTSTRAP_ERROR.DOMAIN_CONFLICT)
    assert.equal(
      partners.filter((p) => p.code === LAURALU_PARTNER_CODE).length,
      0
    )
    assert.equal(bootstrapExitCode(r), 2)
  })

  it("4. P2002 → incomplet → retry unique → succès", async () => {
    const { db, partners, domains } = createPgLikeFake(
      { companies: [{ id: "co_1", name: "One" }] },
      { racePartnerIncompleteOnce: true }
    )
    const r = await bootstrapLauraluPartnerRegistry(db)
    assert.equal(r.companiesSucceeded, 1)
    assert.equal(r.companiesFailed, 0)
    assert.equal(partners.length, 1)
    assert.equal(domains.length, 1)
    // Retry a créé le domaine (partenaire déjà concurrent).
    assert.equal(r.domainsCreated, 1)
    assert.equal(r.partnersCreated, 0)
  })

  it("5. P2002 répété → retry épuisé → failed", async () => {
    const { db } = createPgLikeFake(
      { companies: [{ id: "co_1", name: "One" }] },
      { alwaysRaceIncomplete: true }
    )
    const r = await bootstrapLauraluPartnerRegistry(db)
    assert.equal(r.companiesFailed, 1)
    assert.equal(r.failed[0]!.reason, BOOTSTRAP_ERROR.P2002_RETRY_EXHAUSTED)
    assert.equal(bootstrapExitCode(r), 1)
  })

  it("6. échec domaine non-P2002 → rollback partenaire", async () => {
    const { db, partners, domains } = createPgLikeFake(
      { companies: [{ id: "co_1", name: "One" }] },
      { domainTechnicalError: true }
    )
    const r = await bootstrapLauraluPartnerRegistry(db)
    assert.equal(r.companiesFailed, 1)
    assert.equal(r.failed[0]!.reason, BOOTSTRAP_ERROR.UNKNOWN_ERROR)
    assert.equal(partners.length, 0)
    assert.equal(domains.length, 0)
  })

  it("7. conflit préexistant → aucun partenaire LAURALU", async () => {
    const { db, partners } = createPgLikeFake({
      companies: [{ id: "co_1", name: "One" }],
      partners: [
        {
          id: "p_other",
          companyId: "co_1",
          name: "OTHER",
          code: "other",
          connector: "GMAIL",
          pipeline: LAURALU_PARTNER_PIPELINE,
          active: true,
        },
      ],
      domains: [
        {
          id: "d1",
          companyId: "co_1",
          partnerId: "p_other",
          domainNormalized: LAURALU_DOMAIN_NORMALIZED,
          active: true,
        },
      ],
    })
    const r = await bootstrapLauraluPartnerRegistry(db)
    assert.equal(r.conflicts.length, 1)
    assert.equal(
      partners.filter((p) => p.code === LAURALU_PARTNER_CODE).length,
      0
    )
  })

  it("8. multi-tenant : un échec ne bloque pas les suivants", async () => {
    const { db, partners } = createPgLikeFake(
      {
        companies: [
          { id: "co_ok", name: "OK" },
          { id: "co_fail", name: "FAIL" },
          { id: "co_after", name: "AFTER" },
        ],
      },
      {
        beforeDomainCreate: ({ data }) => {
          if (data.companyId === "co_fail") throw new Error("boom")
        },
      }
    )
    const r = await bootstrapLauraluPartnerRegistry(db)
    assert.equal(r.companiesFailed, 1)
    assert.equal(r.companiesSucceeded, 2)
    assert.equal(partners.filter((p) => p.companyId === "co_after").length, 1)
    assert.equal(partners.filter((p) => p.companyId === "co_fail").length, 0)
  })

  it("9. pas de double alreadyPresent + concurrentlyCreated", async () => {
    const fake = createPgLikeFake({
      companies: [{ id: "co_1", name: "One" }],
    })
    await bootstrapLauraluPartnerRegistry(fake.db)
    const r = await bootstrapLauraluPartnerRegistry(fake.db)
    assert.equal(r.alreadyPresent, 1)
    assert.equal(r.concurrentlyCreated, 0)
  })

  it("10. inactifs = alreadyPresent, aucun write", async () => {
    const { db, partners, domains, writes } = createPgLikeFake({
      companies: [{ id: "co_1", name: "One" }],
      partners: [
        {
          id: "p1",
          companyId: "co_1",
          name: "Custom",
          code: LAURALU_PARTNER_CODE,
          connector: "GMAIL",
          pipeline: "kept",
          active: false,
        },
      ],
      domains: [
        {
          id: "d1",
          companyId: "co_1",
          partnerId: "p1",
          domainNormalized: LAURALU_DOMAIN_NORMALIZED,
          active: false,
        },
      ],
    })
    const r = await bootstrapLauraluPartnerRegistry(db)
    assert.equal(r.alreadyPresent, 1)
    assert.equal(partners[0]!.active, false)
    assert.equal(partners[0]!.pipeline, "kept")
    assert.equal(domains[0]!.active, false)
    assert.equal(writes.length, 0)
  })
})
