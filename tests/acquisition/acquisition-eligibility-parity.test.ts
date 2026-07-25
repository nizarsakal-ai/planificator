/**
 * PLAN-ACQ-012-LOT-1.4 — Parité runtime historique vs registre (lauralu.fr seul).
 *
 * Avec uniquement lauralu.fr actif dans le registre, les décisions doivent
 * matcher l’ancienne règle synchrone `domain === "lauralu.fr"`.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  normalizeSenderAddress,
  registerIncomingMessage,
} from "@/lib/acquisition/acquisition.service"
import { PartnerEligibilityResolver } from "@/lib/acquisition/partner-eligibility.resolver"
import type {
  AcquisitionPartnerDomainRecord,
  AcquisitionPartnerRecord,
  AcquisitionPartnerWithDomainRecord,
  PartnerRegistryRepositoryPort,
} from "@/lib/acquisition/persistence/partner-registry.repository"

/** Ancienne règle historique (référence de parité, hors runtime). */
function historicalEligible(domain: string): boolean {
  return domain === "lauralu.fr"
}

const now = new Date()

function lauraluOnlyRegistry(): PartnerRegistryRepositoryPort {
  const partner: AcquisitionPartnerRecord = {
    id: "p1",
    companyId: "co_parity",
    name: "LAURALU",
    code: "lauralu",
    connector: "GMAIL",
    pipeline: "consultations",
    active: true,
    createdAt: now,
    updatedAt: now,
  }
  const domainRow: AcquisitionPartnerDomainRecord = {
    id: "d1",
    companyId: "co_parity",
    partnerId: "p1",
    domainNormalized: "lauralu.fr",
    active: true,
    createdAt: now,
    updatedAt: now,
  }
  const hit: AcquisitionPartnerWithDomainRecord = { ...partner, domain: domainRow }

  return {
    findPartnerByCode: async () => null,
    findPartnerByDomain: async (companyId, domain) => {
      if (companyId !== "co_parity") return null
      if (domain.trim().toLowerCase() !== "lauralu.fr") return null
      return hit
    },
    findDomain: async () => null,
    listPartners: async () => [],
    listDomains: async () => [],
    partnerExists: async () => false,
    domainExists: async () => false,
  }
}

describe("parité éligibilité historique ↔ registre (lauralu.fr seul)", () => {
  const resolver = new PartnerEligibilityResolver(lauraluOnlyRegistry())

  const samples = [
    "carlenebourgine@lauralu.fr",
    "ELODIEAGEZ@LAURALU.FR",
    "nouveau.collaborateur2027@lauralu.fr",
    "user@gmail.com",
    "user@fake-lauralu.fr",
    "user@lauralu.fr.attacker.com",
    "user@mail.lauralu.fr",
    "Carlene (lauralu.fr) <carlene@evil.com>",
    "Service LAURALU lauralu.fr <contact@attacker.com>",
    "pas-une-adresse",
  ]

  for (const raw of samples) {
    it(`parité resolver pour « ${raw} »`, async () => {
      const n = normalizeSenderAddress(raw)
      const hist = n !== null && historicalEligible(n.domain)
      const next =
        n !== null && (await resolver.isDomainEligible("co_parity", n.domain))
      assert.equal(next, hist)
    })
  }

  it("registerIncomingMessage : admissible lauralu.fr → DRAFT_CREATED", async () => {
    const created: unknown[] = []
    const db = {
      acquisitionMessage: {
        findUnique: async () => null,
        create: async ({ data }: { data: { status: string; lastErrorCode: string | null } }) => {
          created.push(data)
          return { id: "msg1", status: data.status }
        },
      },
      acquisitionAttachment: {
        createMany: async () => ({ count: 0 }),
      },
      worksiteImportDraft: {
        create: async () => ({ id: "draft1" }),
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    }

    const r = await registerIncomingMessage(
      {
        companyId: "co_parity",
        source: "GMAIL",
        externalMessageId: "ext-1",
        senderEmail: "carlene@lauralu.fr",
        subject: "Test",
        receivedAt: new Date(),
        attachments: [],
      },
      db as never,
      { eligibilityResolver: resolver }
    )
    assert.equal(r.outcome, "DRAFT_CREATED")
    assert.equal(r.created, true)
  })

  it("registerIncomingMessage : gmail.com → REJECTED SENDER_NOT_ELIGIBLE", async () => {
    const db = {
      acquisitionMessage: {
        findUnique: async () => null,
        create: async ({ data }: { data: { status: string; lastErrorCode: string | null } }) => ({
          id: "msg2",
          status: data.status,
        }),
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    }

    const r = await registerIncomingMessage(
      {
        companyId: "co_parity",
        source: "GMAIL",
        externalMessageId: "ext-2",
        senderEmail: "user@gmail.com",
        subject: "Test",
        receivedAt: new Date(),
        attachments: [],
      },
      db as never,
      { eligibilityResolver: resolver }
    )
    assert.equal(r.outcome, "REJECTED")
    if (r.outcome === "REJECTED") {
      assert.equal(r.errorCode, "SENDER_NOT_ELIGIBLE")
    }
  })
})
