process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { resolveExtractionProvider } from "@/lib/acquisition/extraction/extraction-provider.factory"
import { DEFAULT_ANTHROPIC_EXTRACTION_MODEL } from "@/lib/acquisition/extraction/anthropic-extraction.config"
import type { AnthropicExtractionClient } from "@/lib/acquisition/extraction/anthropic-extraction.client"
import type { Message } from "@anthropic-ai/sdk/resources/messages"

describe("extraction-provider.factory", () => {
  const env = { ...process.env }

  beforeEach(() => {
    delete process.env.ACQUISITION_EXTRACTION_PROVIDER
    delete process.env.ACQUISITION_EXTRACTION_MODEL
    delete process.env.ANTHROPIC_API_KEY
  })

  afterEach(() => {
    process.env = { ...env }
  })

  it("deterministic par défaut", () => {
    const p = resolveExtractionProvider()
    assert.ok(p)
  })

  it("anthropic non configuré → null (avant claim)", () => {
    process.env.ACQUISITION_EXTRACTION_PROVIDER = "anthropic"
    delete process.env.ANTHROPIC_API_KEY
    const p = resolveExtractionProvider()
    assert.equal(p, null)
  })

  it("anthropic valide → adapter (client injecté)", () => {
    process.env.ACQUISITION_EXTRACTION_PROVIDER = "anthropic"
    process.env.ANTHROPIC_API_KEY = "sk-test"
    process.env.ACQUISITION_EXTRACTION_MODEL = DEFAULT_ANTHROPIC_EXTRACTION_MODEL
    const fake: AnthropicExtractionClient = {
      async messagesCreate() {
        return {
          id: "m",
          type: "message",
          role: "assistant",
          content: [],
          model: DEFAULT_ANTHROPIC_EXTRACTION_MODEL,
          stop_reason: "tool_use",
          stop_details: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        } as unknown as Message
      },
    }
    const p = resolveExtractionProvider({ anthropicClient: fake })
    assert.ok(p)
  })

  it("aucun fallback silencieux vers deterministic si anthropic cassé", () => {
    process.env.ACQUISITION_EXTRACTION_PROVIDER = "anthropic"
    process.env.ANTHROPIC_API_KEY = "sk"
    process.env.ACQUISITION_EXTRACTION_MODEL = "not-a-real-model"
    const p = resolveExtractionProvider()
    assert.equal(p, null)
  })
})
