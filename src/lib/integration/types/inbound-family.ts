/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1A
 * Famille discriminante NormalizedInbound — V1 MESSAGE-only (SPEC §9.3).
 */

export const INBOUND_FAMILY = {
  MESSAGE: "MESSAGE",
} as const

export type InboundFamily =
  (typeof INBOUND_FAMILY)[keyof typeof INBOUND_FAMILY]

export const INBOUND_FAMILY_VALUES = Object.values(INBOUND_FAMILY)
