/**
 * PLAN-ACQ-005B-3 — Config Anthropic (purs, bornés, sans secret exposé).
 */

import {
  getExtractionProviderId,
  getExtractionTimeoutMs,
  type ExtractionProviderId,
} from "@/lib/acquisition/extraction/extraction-feature-flag"

/**
 * Allowlist alignée sur les identifiants documentés du SDK 0.102.0
 * (`Model` dans @anthropic-ai/sdk). Pas d'ID inventé.
 */
export const ANTHROPIC_EXTRACTION_MODEL_ALLOWLIST = [
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
] as const

export type AnthropicExtractionModelId = (typeof ANTHROPIC_EXTRACTION_MODEL_ALLOWLIST)[number]

export const DEFAULT_ANTHROPIC_EXTRACTION_MODEL: AnthropicExtractionModelId = "claude-haiku-4-5"

/** Confiance max acceptée depuis Anthropic (conservateur). */
export const ANTHROPIC_MAX_CONFIDENCE = 0.85

export const EXTRACTION_TOOL_NAME = "extract_worksite_fields" as const

/** Catégories PJ alignées sur AcquisitionAttachmentCategory (Prisma). */
export const ANTHROPIC_ATTACHMENT_CATEGORY_ALLOWLIST = [
  "PLAN",
  "PHOTO",
  "DOCUMENT",
  "ARCHIVE",
  "UNSUPPORTED",
  "UNKNOWN",
] as const

export type AnthropicAttachmentCategory =
  (typeof ANTHROPIC_ATTACHMENT_CATEGORY_ALLOWLIST)[number]

export type AnthropicPublicConfig = {
  providerId: ExtractionProviderId
  model: AnthropicExtractionModelId | null
  maxTokens: number
  /** Timeout adapter (ms) ≤ budget service. */
  timeoutMs: number
  /** Budget service (ms). */
  serviceTimeoutMs: number
  /**
   * Plafond octets UTF-8 du contenu utilisateur JSON complet
   * (subject + body + attachments + structure).
   */
  maxPromptBytes: number
  /** @deprecated alias historique body-only — égal à maxPromptBytes pour compat tests. */
  maxInputBytes: number
  maxResponseBytes: number
  configured: boolean
  /** Présence clé uniquement — jamais la valeur. */
  hasApiKey: boolean
}

function clampInt(raw: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return fallback
  return Math.min(Math.max(Math.floor(raw), min), max)
}

export function getExtractionMaxTokens(): number {
  const raw = Number(process.env.ACQUISITION_EXTRACTION_MAX_TOKENS)
  return clampInt(raw, 512, 4096, 2048)
}

/**
 * Plafond total du prompt utilisateur JSON (défaut 32 KiB).
 * Priorité : ACQUISITION_EXTRACTION_PROVIDER_MAX_PROMPT_BYTES,
 * sinon legacy ACQUISITION_EXTRACTION_PROVIDER_MAX_INPUT_BYTES.
 */
export function getExtractionProviderMaxPromptBytes(): number {
  const promptRaw = Number(process.env.ACQUISITION_EXTRACTION_PROVIDER_MAX_PROMPT_BYTES)
  if (Number.isFinite(promptRaw) && promptRaw > 0) {
    return clampInt(promptRaw, 4_096, 64 * 1024, 32 * 1024)
  }
  const legacy = Number(process.env.ACQUISITION_EXTRACTION_PROVIDER_MAX_INPUT_BYTES)
  return clampInt(legacy, 4_096, 64 * 1024, 32 * 1024)
}

/** @deprecated préférer getExtractionProviderMaxPromptBytes (total user JSON). */
export function getExtractionProviderMaxInputBytes(): number {
  return getExtractionProviderMaxPromptBytes()
}

export function getExtractionProviderMaxResponseBytes(): number {
  const raw = Number(process.env.ACQUISITION_EXTRACTION_PROVIDER_MAX_RESPONSE_BYTES)
  return clampInt(raw, 4_096, 128 * 1024, 64 * 1024)
}

export function getAnthropicApiKeyPresent(): boolean {
  const key = process.env.ANTHROPIC_API_KEY
  return typeof key === "string" && key.trim().length > 0
}

/** Lecture interne uniquement — ne jamais logger / exposer. */
export function readAnthropicApiKey(): string | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim()
  return key ? key : null
}

export function resolveAnthropicExtractionModel(): AnthropicExtractionModelId | null {
  const raw = (process.env.ACQUISITION_EXTRACTION_MODEL ?? "").trim()
  if (!raw) {
    return DEFAULT_ANTHROPIC_EXTRACTION_MODEL
  }
  if ((ANTHROPIC_EXTRACTION_MODEL_ALLOWLIST as readonly string[]).includes(raw)) {
    return raw as AnthropicExtractionModelId
  }
  return null
}

/**
 * Timeout adapter ≤ service timeout (laisse une marge pour le mapping local).
 */
export function getAnthropicAdapterTimeoutMs(serviceTimeoutMs = getExtractionTimeoutMs()): number {
  const margin = Math.min(500, Math.max(100, Math.floor(serviceTimeoutMs * 0.05)))
  return Math.max(1_000, serviceTimeoutMs - margin)
}

/**
 * Config publique (sans secret). `configured` = prêt pour instancier l'adapter.
 * Model env vide → défaut allowlisté ; model invalide → non configuré.
 */
export function getAnthropicPublicConfig(): AnthropicPublicConfig {
  const providerId = getExtractionProviderId()
  const serviceTimeoutMs = getExtractionTimeoutMs()
  const hasApiKey = getAnthropicApiKeyPresent()
  const rawModel = (process.env.ACQUISITION_EXTRACTION_MODEL ?? "").trim()
  let model: AnthropicExtractionModelId | null = null
  if (!rawModel) {
    model = DEFAULT_ANTHROPIC_EXTRACTION_MODEL
  } else if ((ANTHROPIC_EXTRACTION_MODEL_ALLOWLIST as readonly string[]).includes(rawModel)) {
    model = rawModel as AnthropicExtractionModelId
  } else {
    model = null
  }

  const configured = providerId === "anthropic" && hasApiKey && model !== null
  const maxPromptBytes = getExtractionProviderMaxPromptBytes()

  return {
    providerId,
    model,
    maxTokens: getExtractionMaxTokens(),
    timeoutMs: getAnthropicAdapterTimeoutMs(serviceTimeoutMs),
    serviceTimeoutMs,
    maxPromptBytes,
    maxInputBytes: maxPromptBytes,
    maxResponseBytes: getExtractionProviderMaxResponseBytes(),
    configured,
    hasApiKey,
  }
}
