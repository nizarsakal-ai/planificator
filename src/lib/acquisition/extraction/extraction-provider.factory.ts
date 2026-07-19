/**
 * PLAN-ACQ-005B-3 — Factory de sélection provider (sans logique métier).
 */

import { deterministicExtractionProvider } from "@/lib/acquisition/extraction/deterministic-extraction.provider"
import {
  createAnthropicExtractionAdapter,
  type AnthropicAdapterDeps,
} from "@/lib/acquisition/extraction/anthropic-extraction.adapter"
import {
  getAnthropicPublicConfig,
  type AnthropicPublicConfig,
} from "@/lib/acquisition/extraction/anthropic-extraction.config"
import { getExtractionProviderId } from "@/lib/acquisition/extraction/extraction-feature-flag"
import type { ExtractionProviderPort } from "@/lib/acquisition/extraction/extraction-provider.port"
import type { AnthropicExtractionClient } from "@/lib/acquisition/extraction/anthropic-extraction.client"

export type ResolveExtractionProviderDeps = {
  config?: AnthropicPublicConfig
  anthropicClient?: AnthropicExtractionClient
  anthropicAdapterDeps?: AnthropicAdapterDeps
  /** Override tests. */
  deterministic?: ExtractionProviderPort
}

/**
 * Résout le provider configuré.
 * - deterministic → toujours disponible
 * - anthropic + config valide → adapter
 * - anthropic non configuré → null (avant claim, 0 attempt)
 * Aucun fallback silencieux deterministic.
 */
export function resolveExtractionProvider(
  deps: ResolveExtractionProviderDeps = {}
): ExtractionProviderPort | null {
  const providerId = deps.config?.providerId ?? getExtractionProviderId()

  if (providerId === "deterministic") {
    return deps.deterministic ?? deterministicExtractionProvider
  }

  if (providerId === "anthropic") {
    const config = deps.config ?? getAnthropicPublicConfig()
    if (!config.configured || !config.model || !config.hasApiKey) {
      return null
    }
    try {
      return createAnthropicExtractionAdapter({
        ...deps.anthropicAdapterDeps,
        config,
        client: deps.anthropicClient ?? deps.anthropicAdapterDeps?.client,
      })
    } catch {
      return null
    }
  }

  return null
}
