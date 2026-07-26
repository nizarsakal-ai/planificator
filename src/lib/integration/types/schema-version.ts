/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1A
 * Version technique du contrat Platform (NormalizedInbound / admission).
 *
 * Distincte de la version documentaire SPEC (actuellement 1.1.0 R1).
 * Ne pas aligner automatiquement ce schéma sur le numéro de version du document.
 */

export const PLATFORM_SCHEMA_VERSIONS = ["1.0.0"] as const

export type PlatformSchemaVersion = (typeof PLATFORM_SCHEMA_VERSIONS)[number]

/** Première révision du schéma de contrat technique Platform. */
export const PLATFORM_SCHEMA_VERSION_V1: PlatformSchemaVersion = "1.0.0"
