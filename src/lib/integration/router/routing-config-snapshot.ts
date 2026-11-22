/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2C
 * Snapshot de configuration de routage d'UNE société et son empreinte `routingConfigurationVersion`
 * (SPEC LOT-2 §13 ; plan I2, I9).
 *
 * - Ensemble actif pour le matching : Sources enabled, et leurs Rules / Bindings enabled.
 * - Champs retenus : exactement ceux de §13.2.3 (jamais `displayName`, `value` brute ni horodatages).
 * - Ordre total : tri lexicographique par `id`, puis `sourceId` (I9).
 * - Empreinte : `rcv1_` + SHA-256 hex du JSON canonique (clés triées, sans espace) de
 *   `{ v: 1, companyId, sources, rules, bindings }` — `companyId` dans le préambule (§13.4).
 * Pur : aucune I/O, aucun accès base.
 */
import { createHash } from "node:crypto"
import type { InboundSourceRuleType } from "@/lib/integration/types/inbound-source-rule-type"

export const ROUTING_CONFIG_VERSION_PREFIX = "rcv1_" as const

export interface SnapshotSource {
  id: string
  enabled: boolean
}
export interface SnapshotRule {
  id: string
  sourceId: string
  type: InboundSourceRuleType
  normalizedValue: string
  enabled: boolean
}
export interface SnapshotBinding {
  id: string
  sourceId: string
  pipelineId: string
  enabled: boolean
  connectionId: string | null
}

export interface RoutingConfigSnapshot {
  companyId: string
  sources: SnapshotSource[]
  rules: SnapshotRule[]
  bindings: SnapshotBinding[]
}

function byIdThenSource(a: { id: string; sourceId?: string }, b: { id: string; sourceId?: string }): number {
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  const sa = a.sourceId ?? ""
  const sb = b.sourceId ?? ""
  return sa === sb ? 0 : sa < sb ? -1 : 1
}

/**
 * Réduit une configuration brute à l'ensemble actif pour le matching, trié (I9), champs §13.2.3 seulement.
 * Les éléments désactivés et ceux rattachés à une Source désactivée ou absente sont écartés.
 */
export function buildRoutingConfigSnapshot(input: RoutingConfigSnapshot): RoutingConfigSnapshot {
  const sources = input.sources
    .filter((s) => s.enabled)
    .map((s) => ({ id: s.id, enabled: true }))
    .sort(byIdThenSource)
  const active = new Set(sources.map((s) => s.id))
  const rules = input.rules
    .filter((r) => r.enabled && active.has(r.sourceId))
    .map((r) => ({ id: r.id, sourceId: r.sourceId, type: r.type, normalizedValue: r.normalizedValue, enabled: true }))
    .sort(byIdThenSource)
  const bindings = input.bindings
    .filter((b) => b.enabled && active.has(b.sourceId))
    .map((b) => ({ id: b.id, sourceId: b.sourceId, pipelineId: b.pipelineId, enabled: true, connectionId: b.connectionId ?? null }))
    .sort(byIdThenSource)
  return { companyId: input.companyId, sources, rules, bindings }
}

/** JSON canonique : clés d'objet triées, aucun espace ; tableaux dans l'ordre reçu. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
  return `{${entries.join(",")}}`
}

/** `routingConfigurationVersion` du snapshot (recalculé sur l'ensemble actif, quel que soit l'ordre reçu). */
export function computeRoutingConfigurationVersion(input: RoutingConfigSnapshot): string {
  if (!input.companyId) throw new Error("companyId requis pour l'empreinte de configuration")
  const s = buildRoutingConfigSnapshot(input)
  const payload = canonicalJson({ v: 1, companyId: s.companyId, sources: s.sources, rules: s.rules, bindings: s.bindings })
  return ROUTING_CONFIG_VERSION_PREFIX + createHash("sha256").update(payload, "utf8").digest("hex")
}
