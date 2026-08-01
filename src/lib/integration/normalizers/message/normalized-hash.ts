/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1C
 * Hash déterministe versionné du NormalizedMessage.
 */

import { createHash } from "node:crypto"
import type { NormalizedMessage } from "@/lib/integration/contracts/normalized-message"
import { PLATFORM_SCHEMA_VERSION_V1 } from "@/lib/integration/types/schema-version"

/** Préfixe de version d’algorithme — changer = nouveaux hashes (nouvelle version logique). */
const HASH_ALG_VERSION = "v1"

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`
}

export function computeNormalizedMessageHash(message: NormalizedMessage): string {
  const canonical = stableStringify({
    alg: HASH_ALG_VERSION,
    schemaVersion: PLATFORM_SCHEMA_VERSION_V1,
    message,
  })
  return createHash("sha256").update(canonical, "utf8").digest("hex")
}
