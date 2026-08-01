/**
 * LOT-2A — orchestration Source/Rule + garde identité (mock TX).
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { InboundSource } from "@/lib/integration/contracts/inbound-source"
import type { InboundSourceRule } from "@/lib/integration/contracts/inbound-source-rule"
import type { InboundSourceRepositoryPort } from "@/lib/integration/persistence/inbound-source.repository"
import type { InboundSourceRuleRepositoryPort } from "@/lib/integration/persistence/inbound-source-rule.repository"
import type {
  InboundSourceIdentityTxPort,
  UpdateRuleGuardedInput,
} from "@/lib/integration/persistence/inbound-source-identity.tx"
import type { CreateInboundSourceInput } from "@/lib/integration/persistence/inbound-source.mapper"
import type { CreateInboundSourceRuleInput } from "@/lib/integration/persistence/inbound-source-rule.mapper"
import type { UpdateInboundSourceRuleInput } from "@/lib/integration/persistence/inbound-source-rule.mapper"
import {
  InboundSourceIdentityRequiredError,
  InboundSourceLimitExceededError,
  InboundSourceNotFoundError,
  InboundSourceValidationError,
} from "@/lib/integration/persistence/inbound-source.errors"
import { InboundSourceWriteService } from "@/lib/integration/sources/inbound-source-write.service"
import {
  INBOUND_SOURCE_BOUNDS,
  isIdentityRuleType,
} from "@/lib/integration/types/inbound-source-rule-type"
import { PLATFORM_SCHEMA_VERSION_V1 } from "@/lib/integration/types/schema-version"

function iso() {
  return "2026-08-01T10:00:00.000Z"
}

function createMemoryRepos(options?: {
  enabledRulesOverride?: () => number
}) {
  const sources = new Map<string, InboundSource>()
  const rules = new Map<string, InboundSourceRule>()
  let seq = 0
  let identityMutations = 0

  const sourceRepo: InboundSourceRepositoryPort = {
    async create(input: CreateInboundSourceInput) {
      const id = `s${++seq}`
      const row: InboundSource = {
        id,
        companyId: input.companyId,
        displayName: input.displayName,
        enabled: false,
        schemaVersion: PLATFORM_SCHEMA_VERSION_V1,
        createdAt: iso(),
        updatedAt: iso(),
      }
      sources.set(`${input.companyId}:${id}`, row)
      return row
    },
    async findById(companyId, id) {
      const row = sources.get(`${companyId}:${id}`)
      if (!row) throw new InboundSourceNotFoundError()
      return row
    },
    async listByCompany(companyId) {
      return [...sources.values()].filter((s) => s.companyId === companyId)
    },
    async countByCompany(companyId) {
      return [...sources.values()].filter((s) => s.companyId === companyId)
        .length
    },
    async updateDisplayName(input) {
      const row = await this.findById(input.companyId, input.id)
      const next = {
        ...row,
        displayName: input.displayName ?? row.displayName,
        updatedAt: iso(),
      }
      sources.set(`${input.companyId}:${input.id}`, next)
      return next
    },
    async disable(companyId, id) {
      const row = await this.findById(companyId, id)
      const next = { ...row, enabled: false, updatedAt: iso() }
      sources.set(`${companyId}:${id}`, next)
      return next
    },
  }

  const ruleRepo: InboundSourceRuleRepositoryPort = {
    async create(input: CreateInboundSourceRuleInput) {
      const id = `r${++seq}`
      const row: InboundSourceRule = {
        id,
        companyId: input.companyId,
        sourceId: input.sourceId,
        type: input.type,
        value: input.value,
        normalizedValue: input.normalizedValue,
        enabled: input.enabled ?? true,
        schemaVersion: PLATFORM_SCHEMA_VERSION_V1,
        createdAt: iso(),
        updatedAt: iso(),
      }
      rules.set(`${input.companyId}:${id}`, row)
      return row
    },
    async findById(companyId, id) {
      const row = rules.get(`${companyId}:${id}`)
      if (!row) throw new InboundSourceNotFoundError()
      return row
    },
    async listBySource(companyId, sourceId) {
      return [...rules.values()].filter(
        (r) => r.companyId === companyId && r.sourceId === sourceId
      )
    },
    async countBySource(companyId, sourceId) {
      return (await this.listBySource(companyId, sourceId)).length
    },
    async countEnabledByCompany(companyId) {
      if (options?.enabledRulesOverride) {
        return options.enabledRulesOverride()
      }
      return [...rules.values()].filter(
        (r) => r.companyId === companyId && r.enabled
      ).length
    },
    async countEnabledIdentityBySource(companyId, sourceId) {
      return [...rules.values()].filter(
        (r) =>
          r.companyId === companyId &&
          r.sourceId === sourceId &&
          r.enabled &&
          isIdentityRuleType(r.type)
      ).length
    },
    async update(input: UpdateInboundSourceRuleInput) {
      const row = await this.findById(input.companyId, input.id)
      const next = {
        ...row,
        ...(input.value !== undefined ? { value: input.value } : {}),
        ...(input.normalizedValue !== undefined
          ? { normalizedValue: input.normalizedValue }
          : {}),
        updatedAt: iso(),
      }
      rules.set(`${input.companyId}:${input.id}`, next)
      return next
    },
  }

  /** Simule la TX : valide avant mutation ; refuse sans écrire. */
  const identityTx: InboundSourceIdentityTxPort = {
    async setSourceEnabled(companyId, sourceId, enabled) {
      identityMutations++
      const source = await sourceRepo.findById(companyId, sourceId)
      if (enabled) {
        const n = await ruleRepo.countEnabledIdentityBySource(
          companyId,
          sourceId
        )
        if (n < 1) throw new InboundSourceIdentityRequiredError()
      }
      const next = { ...source, enabled, updatedAt: iso() }
      sources.set(`${companyId}:${sourceId}`, next)
      return next
    },
    async updateRuleGuarded(input: UpdateRuleGuardedInput) {
      identityMutations++
      const existing = await ruleRepo.findById(input.companyId, input.ruleId)
      const source = await sourceRepo.findById(
        input.companyId,
        existing.sourceId
      )
      const siblings = await ruleRepo.listBySource(
        input.companyId,
        existing.sourceId
      )
      const simulated = siblings.map((r) =>
        r.id === input.ruleId
          ? {
              ...r,
              type: input.type ?? r.type,
              enabled: input.enabled ?? r.enabled,
            }
          : r
      )
      const identityCount = simulated.filter(
        (r) => r.enabled && isIdentityRuleType(r.type)
      ).length
      if (source.enabled && identityCount < 1) {
        throw new InboundSourceIdentityRequiredError()
      }
      const next: InboundSourceRule = {
        ...existing,
        ...(input.value !== undefined ? { value: input.value } : {}),
        ...(input.normalizedValue !== undefined
          ? { normalizedValue: input.normalizedValue }
          : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        updatedAt: iso(),
      }
      rules.set(`${input.companyId}:${input.ruleId}`, next)
      return next
    },
  }

  return {
    svc: new InboundSourceWriteService(sourceRepo, ruleRepo, identityTx),
    sources,
    rules,
    getIdentityMutations: () => identityMutations,
  }
}

describe("InboundSourceWriteService", () => {
  it("crée Source disabled ; refuse activation sans identité", async () => {
    const { svc } = createMemoryRepos()
    const s = await svc.createSource({
      companyId: "c1",
      displayName: "Src",
    })
    assert.equal(s.enabled, false)
    await assert.rejects(
      () => svc.setSourceEnabled("c1", s.id, true),
      InboundSourceIdentityRequiredError
    )
  })

  it("disable dernière identité refusé sans mutation", async () => {
    const { svc, rules, getIdentityMutations } = createMemoryRepos()
    const s = await svc.createSource({ companyId: "c1", displayName: "Src" })
    const r = await svc.createRule({
      companyId: "c1",
      sourceId: s.id,
      type: "SENDER_EMAIL",
      value: "a@b.co",
    })
    await svc.setSourceEnabled("c1", s.id, true)
    const before = getIdentityMutations()
    const snapshot = structuredClone(rules.get(`c1:${r.id}`))
    await assert.rejects(
      () => svc.setRuleEnabled("c1", r.id, false),
      InboundSourceIdentityRequiredError
    )
    assert.deepEqual(rules.get(`c1:${r.id}`), snapshot)
    assert.equal(rules.get(`c1:${r.id}`)?.enabled, true)
    // La tentative a bien passé par la garde TX (compteur ++) puis rollback logique
    assert.ok(getIdentityMutations() > before)
  })

  it("refuse type identité → qualificatif si dernière identité", async () => {
    const { svc, rules } = createMemoryRepos()
    const s = await svc.createSource({ companyId: "c1", displayName: "Src" })
    const r = await svc.createRule({
      companyId: "c1",
      sourceId: s.id,
      type: "SENDER_EMAIL",
      value: "a@b.co",
    })
    await svc.setSourceEnabled("c1", s.id, true)
    await assert.rejects(
      () =>
        svc.updateRule({
          companyId: "c1",
          id: r.id,
          type: "SUBJECT_KEYWORD",
          value: "devis",
        }),
      InboundSourceIdentityRequiredError
    )
    assert.equal(rules.get(`c1:${r.id}`)?.type, "SENDER_EMAIL")
  })

  it("active Source avec identité ; refuse keyword invalide", async () => {
    const { svc } = createMemoryRepos()
    const s = await svc.createSource({ companyId: "c1", displayName: "Src" })
    await svc.createRule({
      companyId: "c1",
      sourceId: s.id,
      type: "SENDER_EMAIL",
      value: "a@b.co",
    })
    const enabled = await svc.setSourceEnabled("c1", s.id, true)
    assert.equal(enabled.enabled, true)
    await assert.rejects(
      () =>
        svc.createRule({
          companyId: "c1",
          sourceId: s.id,
          type: "SUBJECT_KEYWORD",
          value: "   ",
        }),
      InboundSourceValidationError
    )
  })

  it("plafond 50 Rules / Source (séquentiel best-effort)", async () => {
    const { svc } = createMemoryRepos()
    const s = await svc.createSource({ companyId: "c1", displayName: "Src" })
    for (let i = 0; i < INBOUND_SOURCE_BOUNDS.RULES_PER_SOURCE_MAX; i++) {
      await svc.createRule({
        companyId: "c1",
        sourceId: s.id,
        type: "SENDER_EMAIL",
        value: `u${i}@ex.com`,
        enabled: false,
      })
    }
    await assert.rejects(
      () =>
        svc.createRule({
          companyId: "c1",
          sourceId: s.id,
          type: "SENDER_EMAIL",
          value: "last@ex.com",
          enabled: false,
        }),
      InboundSourceLimitExceededError
    )
  })

  it("plafond 200 Sources / tenant (séquentiel best-effort)", async () => {
    const { svc } = createMemoryRepos()
    for (let i = 0; i < INBOUND_SOURCE_BOUNDS.SOURCES_PER_TENANT_MAX; i++) {
      await svc.createSource({ companyId: "c1", displayName: `S${i}` })
    }
    await assert.rejects(
      () => svc.createSource({ companyId: "c1", displayName: "overflow" }),
      InboundSourceLimitExceededError
    )
  })

  it("plafond 2000 Rules actives / tenant (séquentiel best-effort)", async () => {
    const { svc } = createMemoryRepos({
      enabledRulesOverride: () =>
        INBOUND_SOURCE_BOUNDS.ACTIVE_RULES_PER_TENANT_MAX,
    })
    const s = await svc.createSource({ companyId: "c1", displayName: "Src" })
    await assert.rejects(
      () =>
        svc.createRule({
          companyId: "c1",
          sourceId: s.id,
          type: "SENDER_EMAIL",
          value: "a@b.co",
          enabled: true,
        }),
      InboundSourceLimitExceededError
    )
  })
})
