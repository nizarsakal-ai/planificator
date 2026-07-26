/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1A
 * Identifiant technique opaque de ConnectorType (registry produit).
 * Aucune valeur concrète de connecteur en STEP-1.
 */

declare const connectorTypeBrand: unique symbol

export type ConnectorType = string & {
  readonly [connectorTypeBrand]: true
}
