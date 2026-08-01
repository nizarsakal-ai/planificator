/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2A
 * Invariants Source / Rule — sans Prisma, sans Router.
 */

import type { InboundSourceRule } from "@/lib/integration/contracts/inbound-source-rule"
import {
  INBOUND_SOURCE_BOUNDS,
  isIdentityRuleType,
} from "@/lib/integration/types/inbound-source-rule-type"
import {
  InboundSourceIdentityRequiredError,
  InboundSourceLimitExceededError,
} from "@/lib/integration/persistence/inbound-source.errors"

export function assertSourcesPerTenantLimit(currentCount: number): void {
  if (currentCount >= INBOUND_SOURCE_BOUNDS.SOURCES_PER_TENANT_MAX) {
    throw new InboundSourceLimitExceededError(
      `maximum ${INBOUND_SOURCE_BOUNDS.SOURCES_PER_TENANT_MAX} Sources / tenant`
    )
  }
}

export function assertRulesPerSourceLimit(currentCount: number): void {
  if (currentCount >= INBOUND_SOURCE_BOUNDS.RULES_PER_SOURCE_MAX) {
    throw new InboundSourceLimitExceededError(
      `maximum ${INBOUND_SOURCE_BOUNDS.RULES_PER_SOURCE_MAX} Rules / Source`
    )
  }
}

export function assertActiveRulesPerTenantLimit(currentEnabled: number): void {
  if (currentEnabled >= INBOUND_SOURCE_BOUNDS.ACTIVE_RULES_PER_TENANT_MAX) {
    throw new InboundSourceLimitExceededError(
      `maximum ${INBOUND_SOURCE_BOUNDS.ACTIVE_RULES_PER_TENANT_MAX} Rules actives / tenant`
    )
  }
}

/** Source enabled ⇒ ≥ 1 rule IDENTITÉ enabled. */
export function assertActiveIdentityPresent(
  enabledIdentityCount: number
): void {
  if (enabledIdentityCount < 1) {
    throw new InboundSourceIdentityRequiredError()
  }
}

export function countEnabledIdentityRules(
  rules: readonly Pick<InboundSourceRule, "type" | "enabled">[]
): number {
  return rules.filter((r) => r.enabled && isIdentityRuleType(r.type)).length
}
