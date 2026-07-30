/**
 * PLAN-ACQ-012-LOT-1.4-R2 — Runtime registerIncomingMessage × éligibilité.
 *
 * Couvre : panne resolver (zéro persistance), registre vide volontaire,
 * actif/inactif, isolation multi-tenant à états différents, message rejet.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { registerIncomingMessage } from "@/lib/acquisition/acquisition.service"
import { PartnerEligibilityResolver } from "@/lib/acquisition/partner-eligibility.resolver"
import type { PartnerEligibilityResolverPort } from "@/lib/acquisition/partner-eligibility.resolver"
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
    priority: 100,
    requireExactEmail: false,
    autoApproveEnabled: false,
    autoConvertEnabled: false,
    minConfidence: null,
    createdAt: now,
    updatedAt: now,
    ...partial,
    allowCreateClient: partial.allowCreateClient ?? false,
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

function hit(
  p: AcquisitionPartnerRecord,
  d: AcquisitionPartnerDomainRecord
): AcquisitionPartnerWithDomainRecord {
  return { ...p, domain: d }
}

type FindCall = { companyId: string; domain: string }

function trackingRegistry(
  hits: Map<string, AcquisitionPartnerWithDomainRecord | null>,
  options?: { throwOnFind?: Error }
): PartnerRegistryRepositoryPort & { findCalls: FindCall[] } {
  const findCalls: FindCall[] = []
  return {
    findCalls,
    findPartnerByCode: async () => null,
    findPartnerById: async () => null,
    findPartnerByEmail: async () => null,
    findPartnerByDomain: async (companyId, domainName) => {
      findCalls.push({ companyId, domain: domainName })
      if (options?.throwOnFind) throw options.throwOnFind
      const key = `${companyId}::${domainName}`
      return hits.has(key) ? hits.get(key)! : null
    },
    findDomain: async () => null,
    listPartners: async () => [],
    listDomains: async () => [],
    listEmails: async () => [],
    partnerExists: async () => false,
    domainExists: async () => false,
  }
}

type CreatedMessage = {
  status: string
  lastErrorCode: string | null
  lastErrorMessage: string | null
}

function trackingDb() {
  const created: CreatedMessage[] = []
  let transactionCalls = 0
  let messageCreateCalls = 0

  const db = {
    acquisitionMessage: {
      findUnique: async () => null,
      create: async ({ data }: { data: CreatedMessage }) => {
        messageCreateCalls += 1
        created.push({
          status: data.status,
          lastErrorCode: data.lastErrorCode,
          lastErrorMessage: data.lastErrorMessage,
        })
        return { id: `msg_${messageCreateCalls}`, status: data.status }
      },
    },
    acquisitionAttachment: {
      createMany: async () => ({ count: 0 }),
    },
    worksiteImportDraft: {
      create: async () => ({ id: "draft1" }),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      transactionCalls += 1
      return fn(db)
    },
  }

  return {
    db,
    created,
    get transactionCalls() {
      return transactionCalls
    },
    get messageCreateCalls() {
      return messageCreateCalls
    },
  }
}

function baseInput(companyId: string, senderEmail: string, externalId: string) {
  return {
    companyId,
    source: "GMAIL" as const,
    externalMessageId: externalId,
    senderEmail,
    subject: "Test",
    receivedAt: new Date(),
    attachments: [] as [],
  }
}

describe("registerIncomingMessage × éligibilité (R2)", () => {
  it("panne resolver : exception remonte, zéro TX, zéro AcquisitionMessage, message rejouable", async () => {
    const err = Object.assign(new Error("db down"), { code: "P1001" })
    const registry = trackingRegistry(new Map(), { throwOnFind: err })
    const resolver = new PartnerEligibilityResolver(registry)
    const track = trackingDb()

    await assert.rejects(
      () =>
        registerIncomingMessage(
          baseInput("co_a", "carlene@lauralu.fr", "ext-fail-1"),
          track.db as never,
          { eligibilityResolver: resolver }
        ),
      (e: unknown) => e === err
    )

    assert.deepEqual(registry.findCalls, [{ companyId: "co_a", domain: "lauralu.fr" }])
    assert.equal(track.transactionCalls, 0)
    assert.equal(track.messageCreateCalls, 0)
    assert.equal(track.created.length, 0)
  })

  it("volontaire — registre vide : REJECTED / SENDER_NOT_ELIGIBLE (bootstrap obligatoire avant deploy)", async () => {
    const registry = trackingRegistry(new Map())
    const resolver = new PartnerEligibilityResolver(registry)
    const track = trackingDb()

    const r = await registerIncomingMessage(
      baseInput("co_empty", "carlene@lauralu.fr", "ext-empty-1"),
      track.db as never,
      { eligibilityResolver: resolver }
    )

    assert.deepEqual(registry.findCalls, [
      { companyId: "co_empty", domain: "lauralu.fr" },
    ])
    assert.equal(r.outcome, "REJECTED")
    if (r.outcome === "REJECTED") {
      assert.equal(r.errorCode, "SENDER_NOT_ELIGIBLE")
    }
    assert.equal(track.transactionCalls, 1)
    assert.equal(track.messageCreateCalls, 1)
    assert.equal(track.created[0]?.status, "REJECTED")
    assert.equal(track.created[0]?.lastErrorCode, "SENDER_NOT_ELIGIBLE")
    assert.equal(track.created[0]?.lastErrorMessage, "Expéditeur non admissible (registre partenaires)")
    assert.equal(
      track.created[0]?.lastErrorMessage?.includes("attendu"),
      false,
      "message générique (multi-domaines) — pas de « attendu : lauralu.fr »"
    )
  })

  it("idempotence registre vide : second appel même clé → duplicate, aucune 2ᵉ ligne", async () => {
    const registry = trackingRegistry(new Map())
    const resolver = new PartnerEligibilityResolver(registry)

    const existing = {
      id: "msg_frozen",
      status: "REJECTED" as const,
      lastErrorCode: "SENDER_NOT_ELIGIBLE" as const,
      draft: null as { id: string } | null,
    }

    let findCalls = 0
    let createCalls = 0
    let transactionCalls = 0

    const db = {
      acquisitionMessage: {
        findUnique: async () => {
          findCalls += 1
          // 1er appel : absent ; après create simulé, les rappels voient l’existant
          return findCalls === 1 ? null : existing
        },
        create: async ({
          data,
        }: {
          data: { status: string; lastErrorCode: string | null }
        }) => {
          createCalls += 1
          return { id: existing.id, status: data.status }
        },
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        transactionCalls += 1
        return fn(db)
      },
    }

    const input = baseInput("co_empty", "carlene@lauralu.fr", "ext-idem-empty")

    const r1 = await registerIncomingMessage(input, db as never, {
      eligibilityResolver: resolver,
    })
    assert.equal(r1.outcome, "REJECTED")
    assert.equal(r1.created, true)
    assert.equal(createCalls, 1)
    assert.equal(transactionCalls, 1)

    const r2 = await registerIncomingMessage(input, db as never, {
      eligibilityResolver: resolver,
    })
    assert.equal(r2.outcome, "REJECTED")
    assert.equal(r2.created, false)
    assert.equal(r2.messageId, existing.id)
    assert.equal(createCalls, 1, "aucune deuxième ligne créée")
    assert.equal(transactionCalls, 1, "pas de 2ᵉ transaction d’écriture")
  })

  it("partenaire actif + domaine actif → DRAFT_CREATED", async () => {
    const p = partner({ id: "p1", companyId: "co_a", code: "lauralu", active: true })
    const d = domain({
      id: "d1",
      companyId: "co_a",
      partnerId: "p1",
      domainNormalized: "lauralu.fr",
      active: true,
    })
    const registry = trackingRegistry(new Map([["co_a::lauralu.fr", hit(p, d)]]))
    const track = trackingDb()

    const r = await registerIncomingMessage(
      baseInput("co_a", "user@lauralu.fr", "ext-ok-1"),
      track.db as never,
      { eligibilityResolver: new PartnerEligibilityResolver(registry) }
    )

    assert.deepEqual(registry.findCalls, [{ companyId: "co_a", domain: "lauralu.fr" }])
    assert.equal(r.outcome, "DRAFT_CREATED")
    assert.equal(track.created[0]?.status, "DRAFT_CREATED")
    assert.equal(track.created[0]?.lastErrorCode, null)
  })

  it("partenaire inactif → REJECTED SENDER_NOT_ELIGIBLE", async () => {
    const p = partner({ id: "p1", companyId: "co_a", code: "lauralu", active: false })
    const d = domain({
      id: "d1",
      companyId: "co_a",
      partnerId: "p1",
      domainNormalized: "lauralu.fr",
      active: true,
    })
    const registry = trackingRegistry(new Map([["co_a::lauralu.fr", hit(p, d)]]))
    const track = trackingDb()

    const r = await registerIncomingMessage(
      baseInput("co_a", "user@lauralu.fr", "ext-inactive-p"),
      track.db as never,
      { eligibilityResolver: new PartnerEligibilityResolver(registry) }
    )

    assert.equal(r.outcome, "REJECTED")
    if (r.outcome === "REJECTED") assert.equal(r.errorCode, "SENDER_NOT_ELIGIBLE")
    assert.equal(track.created[0]?.status, "REJECTED")
  })

  it("domaine inactif → REJECTED SENDER_NOT_ELIGIBLE", async () => {
    const p = partner({ id: "p1", companyId: "co_a", code: "lauralu", active: true })
    const d = domain({
      id: "d1",
      companyId: "co_a",
      partnerId: "p1",
      domainNormalized: "lauralu.fr",
      active: false,
    })
    const registry = trackingRegistry(new Map([["co_a::lauralu.fr", hit(p, d)]]))
    const track = trackingDb()

    const r = await registerIncomingMessage(
      baseInput("co_a", "user@lauralu.fr", "ext-inactive-d"),
      track.db as never,
      { eligibilityResolver: new PartnerEligibilityResolver(registry) }
    )

    assert.equal(r.outcome, "REJECTED")
    if (r.outcome === "REJECTED") assert.equal(r.errorCode, "SENDER_NOT_ELIGIBLE")
  })

  it("même domaine : tenant A actif accepté, tenant B inactif rejeté", async () => {
    const pA = partner({ id: "pa", companyId: "co_a", code: "lauralu", active: true })
    const dA = domain({
      id: "da",
      companyId: "co_a",
      partnerId: "pa",
      domainNormalized: "lauralu.fr",
      active: true,
    })
    const pB = partner({ id: "pb", companyId: "co_b", code: "lauralu", active: false })
    const dB = domain({
      id: "db",
      companyId: "co_b",
      partnerId: "pb",
      domainNormalized: "lauralu.fr",
      active: true,
    })
    const registry = trackingRegistry(
      new Map([
        ["co_a::lauralu.fr", hit(pA, dA)],
        ["co_b::lauralu.fr", hit(pB, dB)],
      ])
    )
    const resolver = new PartnerEligibilityResolver(registry)

    const trackA = trackingDb()
    const rA = await registerIncomingMessage(
      baseInput("co_a", "user@lauralu.fr", "ext-tenant-a"),
      trackA.db as never,
      { eligibilityResolver: resolver }
    )
    assert.equal(rA.outcome, "DRAFT_CREATED")

    const trackB = trackingDb()
    const rB = await registerIncomingMessage(
      baseInput("co_b", "user@lauralu.fr", "ext-tenant-b"),
      trackB.db as never,
      { eligibilityResolver: resolver }
    )
    assert.equal(rB.outcome, "REJECTED")

    assert.deepEqual(registry.findCalls, [
      { companyId: "co_a", domain: "lauralu.fr" },
      { companyId: "co_b", domain: "lauralu.fr" },
    ])
  })

  it("même domaine : tenant B absent → rejeté (pas d’éligibilité cross-tenant)", async () => {
    const pA = partner({ id: "pa", companyId: "co_a", code: "lauralu", active: true })
    const dA = domain({
      id: "da",
      companyId: "co_a",
      partnerId: "pa",
      domainNormalized: "lauralu.fr",
      active: true,
    })
    const registry = trackingRegistry(new Map([["co_a::lauralu.fr", hit(pA, dA)]]))
    const track = trackingDb()

    const r = await registerIncomingMessage(
      baseInput("co_b", "user@lauralu.fr", "ext-tenant-absent"),
      track.db as never,
      { eligibilityResolver: new PartnerEligibilityResolver(registry) }
    )

    assert.deepEqual(registry.findCalls, [{ companyId: "co_b", domain: "lauralu.fr" }])
    assert.equal(r.outcome, "REJECTED")
  })

  it("panne Prisma via port injecté : jamais de rejet métier persisté", async () => {
    const err = Object.assign(new Error("timeout"), { code: "P2024" })
    const eligibilityResolver: PartnerEligibilityResolverPort = {
      isDomainEligible: async () => {
        throw err
      },
      resolveEligibleSender: async (companyId, _email, domainName) => {
        assert.equal(companyId, "co_a")
        assert.equal(domainName, "lauralu.fr")
        throw err
      },
    }
    const track = trackingDb()

    await assert.rejects(
      () =>
        registerIncomingMessage(
          baseInput("co_a", "user@lauralu.fr", "ext-prisma-fail"),
          track.db as never,
          { eligibilityResolver }
        ),
      (e: unknown) => e === err
    )

    assert.equal(track.transactionCalls, 0)
    assert.equal(track.messageCreateCalls, 0)
    assert.equal(track.created.length, 0)
  })
})
