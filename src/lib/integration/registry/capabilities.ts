/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1A / STEP-4
 * Helpers purs pour capability sets (IMPL §20.2).
 *
 * Aucune logique métier, auth, I/O, cache ni état global.
 */

import {
  INTEGRATION_CAPABILITY_VALUES,
  type IntegrationCapability,
} from "@/lib/integration/types/integration-capability"

/** Ensemble de capacités immutable côté API publique. */
export type CapabilitySet = readonly IntegrationCapability[]

const CANONICAL_ORDER: readonly IntegrationCapability[] = INTEGRATION_CAPABILITY_VALUES

/**
 * Crée un capability set readonly : déduplication + ordre canonique stable.
 */
export function createCapabilitySet(
  capabilities: readonly IntegrationCapability[]
): CapabilitySet {
  const seen = new Set<IntegrationCapability>()
  for (const capability of capabilities) {
    seen.add(capability)
  }
  const ordered = CANONICAL_ORDER.filter((capability) => seen.has(capability))
  return Object.freeze(ordered)
}

export function hasCapability(
  set: CapabilitySet,
  capability: IntegrationCapability
): boolean {
  return set.includes(capability)
}
