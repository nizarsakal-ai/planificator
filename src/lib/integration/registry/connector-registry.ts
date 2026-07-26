/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1A / STEP-4
 * Connector registry déclaratif minimal (IMPL §20.1).
 *
 * Option A : map readonly construite depuis une liste injectée.
 * Aucune valeur ConnectorType concrète, aucune factory Runtime, aucun singleton mutable.
 * Famille V1 = MESSAGE uniquement.
 */

import { createCapabilitySet, type CapabilitySet } from "@/lib/integration/registry/capabilities"
import type { ConnectorType } from "@/lib/integration/types/connector-type"
import { INBOUND_FAMILY, type InboundFamily } from "@/lib/integration/types/inbound-family"
import type { IntegrationCapability } from "@/lib/integration/types/integration-capability"
import {
  PLATFORM_SCHEMA_VERSION_V1,
  type PlatformSchemaVersion,
} from "@/lib/integration/types/schema-version"

export type ConnectorRegistryEntry = {
  readonly connectorType: ConnectorType
  readonly family: Extract<InboundFamily, "MESSAGE">
  readonly capabilities: CapabilitySet
  readonly schemaVersion: PlatformSchemaVersion
}

export type ConnectorRegistryInputEntry = {
  readonly connectorType: ConnectorType
  readonly family: InboundFamily
  readonly capabilities: readonly IntegrationCapability[]
  readonly schemaVersion?: PlatformSchemaVersion
}

export type ConnectorRegistry = {
  readonly size: number
  get(connectorType: ConnectorType): ConnectorRegistryEntry | undefined
  list(): readonly ConnectorRegistryEntry[]
}

/** Codes d’erreur stables — sans donnée sensible. */
export const CONNECTOR_REGISTRY_ERROR = {
  DUPLICATE_TYPE: "CONNECTOR_REGISTRY_DUPLICATE_TYPE",
  FAMILY_NOT_SUPPORTED: "CONNECTOR_REGISTRY_FAMILY_NOT_SUPPORTED",
} as const

export class ConnectorRegistryError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = "ConnectorRegistryError"
    this.code = code
  }
}

/**
 * Construit un registry readonly.
 * Liste vide autorisée (aucun ConnectorType concret en STEP-4).
 */
export function createConnectorRegistry(
  entries: readonly ConnectorRegistryInputEntry[] = []
): ConnectorRegistry {
  const byType = new Map<string, ConnectorRegistryEntry>()

  for (const entry of entries) {
    if (entry.family !== INBOUND_FAMILY.MESSAGE) {
      throw new ConnectorRegistryError(CONNECTOR_REGISTRY_ERROR.FAMILY_NOT_SUPPORTED)
    }

    const key = entry.connectorType
    if (byType.has(key)) {
      throw new ConnectorRegistryError(CONNECTOR_REGISTRY_ERROR.DUPLICATE_TYPE)
    }

    const normalized: ConnectorRegistryEntry = Object.freeze({
      connectorType: entry.connectorType,
      family: INBOUND_FAMILY.MESSAGE,
      capabilities: createCapabilitySet(entry.capabilities),
      schemaVersion: entry.schemaVersion ?? PLATFORM_SCHEMA_VERSION_V1,
    })
    byType.set(key, normalized)
  }

  const list = Object.freeze(Array.from(byType.values()))

  return Object.freeze({
    get size() {
      return byType.size
    },
    get(connectorType: ConnectorType) {
      return byType.get(connectorType)
    },
    list() {
      return list
    },
  })
}
