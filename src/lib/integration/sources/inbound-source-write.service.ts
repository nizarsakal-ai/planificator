/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2A
 * Orchestration d’écriture Source / Rule.
 *
 * Invariant identité (atomique via InboundSourceIdentityTx) :
 *   Source.enabled=true ⇒ ≥ 1 rule IDENTITÉ enabled.
 *
 * Plafonds 200 Sources / 50 Rules / 2000 Rules actives :
 *   **best-effort V1** sous concurrence (count→assert→write séquentiel,
 *   sans verrou SQL global). Pas de garantie stricte multi-writer.
 *
 * Pas d’API HTTP ; pas de Router ; pas de matching ; pas d’import Prisma.
 */

import type { InboundSource } from "@/lib/integration/contracts/inbound-source"
import type { InboundSourceRule } from "@/lib/integration/contracts/inbound-source-rule"
import type { InboundSourceRuleType } from "@/lib/integration/types/inbound-source-rule-type"
import {
  InboundSourceRepository,
  type InboundSourceRepositoryPort,
} from "@/lib/integration/persistence/inbound-source.repository"
import {
  InboundSourceRuleRepository,
  type InboundSourceRuleRepositoryPort,
} from "@/lib/integration/persistence/inbound-source-rule.repository"
import {
  InboundSourceIdentityTx,
  type InboundSourceIdentityTxPort,
} from "@/lib/integration/persistence/inbound-source-identity.tx"
import {
  RuleValueNormalizationError,
  normalizeRuleValue,
} from "@/lib/integration/rules/normalize-rule-value"
import { InboundSourceValidationError } from "@/lib/integration/persistence/inbound-source.errors"
import {
  assertActiveRulesPerTenantLimit,
  assertRulesPerSourceLimit,
  assertSourcesPerTenantLimit,
} from "@/lib/integration/sources/inbound-source.validation"

export type CreateSourceCommand = {
  companyId: string
  displayName: string
}

export type CreateRuleCommand = {
  companyId: string
  sourceId: string
  type: InboundSourceRuleType
  value: string
  enabled?: boolean
}

export type UpdateRuleCommand = {
  companyId: string
  id: string
  value?: string
  enabled?: boolean
  /** Changement de type (ex. identité → qualificatif) — garanti sous TX. */
  type?: InboundSourceRuleType
}

export class InboundSourceWriteService {
  constructor(
    private readonly sources: InboundSourceRepositoryPort = new InboundSourceRepository(),
    private readonly rules: InboundSourceRuleRepositoryPort = new InboundSourceRuleRepository(),
    private readonly identityTx: InboundSourceIdentityTxPort = new InboundSourceIdentityTx()
  ) {}

  async createSource(cmd: CreateSourceCommand): Promise<InboundSource> {
    // Plafond best-effort V1 (non atomique sous concurrence multi-writer).
    const count = await this.sources.countByCompany(cmd.companyId)
    assertSourcesPerTenantLimit(count)
    return this.sources.create({
      companyId: cmd.companyId,
      displayName: cmd.displayName,
      enabled: false,
    })
  }

  async updateSourceDisplayName(
    companyId: string,
    id: string,
    displayName: string
  ): Promise<InboundSource> {
    return this.sources.updateDisplayName({ companyId, id, displayName })
  }

  /**
   * Activation / désactivation Source.
   * enabled=true : uniquement via TX identité (jamais via repository).
   */
  async setSourceEnabled(
    companyId: string,
    id: string,
    enabled: boolean
  ): Promise<InboundSource> {
    return this.identityTx.setSourceEnabled(companyId, id, enabled)
  }

  async createRule(cmd: CreateRuleCommand): Promise<InboundSourceRule> {
    await this.sources.findById(cmd.companyId, cmd.sourceId)
    // Plafonds best-effort V1.
    const perSource = await this.rules.countBySource(
      cmd.companyId,
      cmd.sourceId
    )
    assertRulesPerSourceLimit(perSource)

    const enabled = cmd.enabled ?? true
    if (enabled) {
      const active = await this.rules.countEnabledByCompany(cmd.companyId)
      assertActiveRulesPerTenantLimit(active)
    }

    let normalizedValue: string
    try {
      normalizedValue = normalizeRuleValue(cmd.type, cmd.value)
    } catch (error) {
      if (error instanceof RuleValueNormalizationError) {
        throw new InboundSourceValidationError(error.message)
      }
      throw error
    }

    return this.rules.create({
      companyId: cmd.companyId,
      sourceId: cmd.sourceId,
      type: cmd.type,
      value: cmd.value,
      normalizedValue,
      enabled,
    })
  }

  /**
   * Mise à jour Rule sous garde identité atomique.
   * Pas de déplacement cross-Source en V1 (sourceId immuable).
   */
  async updateRule(cmd: UpdateRuleCommand): Promise<InboundSourceRule> {
    const existing = await this.rules.findById(cmd.companyId, cmd.id)
    const nextType = cmd.type ?? existing.type

    let normalizedValue: string | undefined
    if (cmd.value !== undefined || cmd.type !== undefined) {
      const valueForNorm = cmd.value ?? existing.value
      try {
        normalizedValue = normalizeRuleValue(nextType, valueForNorm)
      } catch (error) {
        if (error instanceof RuleValueNormalizationError) {
          throw new InboundSourceValidationError(error.message)
        }
        throw error
      }
    }

    if (cmd.enabled === true && !existing.enabled) {
      // Plafond best-effort V1.
      const active = await this.rules.countEnabledByCompany(cmd.companyId)
      assertActiveRulesPerTenantLimit(active)
    }

    return this.identityTx.updateRuleGuarded({
      companyId: cmd.companyId,
      ruleId: cmd.id,
      ...(cmd.value !== undefined ? { value: cmd.value } : {}),
      ...(normalizedValue !== undefined ? { normalizedValue } : {}),
      ...(cmd.enabled !== undefined ? { enabled: cmd.enabled } : {}),
      ...(cmd.type !== undefined ? { type: cmd.type } : {}),
    })
  }

  async setRuleEnabled(
    companyId: string,
    id: string,
    enabled: boolean
  ): Promise<InboundSourceRule> {
    return this.updateRule({ companyId, id, enabled })
  }
}
