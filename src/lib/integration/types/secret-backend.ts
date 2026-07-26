/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1A
 * Discriminateur secretBackend (SECURITY-SPEC §4.1).
 */

export const SECRET_BACKENDS = {
  LEGACY_GMAIL: "LEGACY_GMAIL",
  PLATFORM_ENCRYPTED: "PLATFORM_ENCRYPTED",
} as const

export type SecretBackend = (typeof SECRET_BACKENDS)[keyof typeof SECRET_BACKENDS]

export const SECRET_BACKEND_VALUES = [
  SECRET_BACKENDS.LEGACY_GMAIL,
  SECRET_BACKENDS.PLATFORM_ENCRYPTED,
] as const satisfies readonly SecretBackend[]
