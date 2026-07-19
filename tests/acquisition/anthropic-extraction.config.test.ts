process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import {
  ANTHROPIC_EXTRACTION_MODEL_ALLOWLIST,
  DEFAULT_ANTHROPIC_EXTRACTION_MODEL,
  getAnthropicPublicConfig,
  getExtractionMaxTokens,
  getExtractionProviderMaxInputBytes,
  readAnthropicApiKey,
} from "@/lib/acquisition/extraction/anthropic-extraction.config"

describe("anthropic-extraction.config", () => {
  const env = { ...process.env }

  beforeEach(() => {
    delete process.env.ACQUISITION_EXTRACTION_PROVIDER
    delete process.env.ACQUISITION_EXTRACTION_MODEL
    delete process.env.ACQUISITION_EXTRACTION_MAX_TOKENS
    delete process.env.ACQUISITION_EXTRACTION_PROVIDER_MAX_INPUT_BYTES
    delete process.env.ACQUISITION_EXTRACTION_PROVIDER_MAX_PROMPT_BYTES
    delete process.env.ACQUISITION_EXTRACTION_TIMEOUT_MS
    delete process.env.ANTHROPIC_API_KEY
  })

  afterEach(() => {
    process.env = { ...env }
  })

  it("provider défaut = deterministic", () => {
    const c = getAnthropicPublicConfig()
    assert.equal(c.providerId, "deterministic")
    assert.equal(c.configured, false)
  })

  it("anthropic sans clé → non configuré", () => {
    process.env.ACQUISITION_EXTRACTION_PROVIDER = "anthropic"
    process.env.ACQUISITION_EXTRACTION_MODEL = DEFAULT_ANTHROPIC_EXTRACTION_MODEL
    const c = getAnthropicPublicConfig()
    assert.equal(c.hasApiKey, false)
    assert.equal(c.configured, false)
  })

  it("modèle invalide → non configuré", () => {
    process.env.ACQUISITION_EXTRACTION_PROVIDER = "anthropic"
    process.env.ANTHROPIC_API_KEY = "sk-test"
    process.env.ACQUISITION_EXTRACTION_MODEL = "claude-invented-99"
    const c = getAnthropicPublicConfig()
    assert.equal(c.model, null)
    assert.equal(c.configured, false)
  })

  it("modèle allowlisté + clé → configuré", () => {
    process.env.ACQUISITION_EXTRACTION_PROVIDER = "anthropic"
    process.env.ANTHROPIC_API_KEY = "sk-test"
    process.env.ACQUISITION_EXTRACTION_MODEL = ANTHROPIC_EXTRACTION_MODEL_ALLOWLIST[0]
    const c = getAnthropicPublicConfig()
    assert.equal(c.configured, true)
    assert.equal(c.model, ANTHROPIC_EXTRACTION_MODEL_ALLOWLIST[0])
    assert.equal("apiKey" in c, false)
    assert.equal(JSON.stringify(c).includes("sk-test"), false)
  })

  it("max tokens clamp 512–4096", () => {
    process.env.ACQUISITION_EXTRACTION_MAX_TOKENS = "100"
    assert.equal(getExtractionMaxTokens(), 512)
    process.env.ACQUISITION_EXTRACTION_MAX_TOKENS = "99999"
    assert.equal(getExtractionMaxTokens(), 4096)
  })

  it("prompt bytes clamp (PROMPT ou legacy INPUT)", () => {
    process.env.ACQUISITION_EXTRACTION_PROVIDER_MAX_PROMPT_BYTES = "100"
    assert.equal(getExtractionProviderMaxInputBytes(), 4096)
    process.env.ACQUISITION_EXTRACTION_PROVIDER_MAX_PROMPT_BYTES = "999999"
    assert.equal(getExtractionProviderMaxInputBytes(), 65536)
    delete process.env.ACQUISITION_EXTRACTION_PROVIDER_MAX_PROMPT_BYTES
    process.env.ACQUISITION_EXTRACTION_PROVIDER_MAX_INPUT_BYTES = "8192"
    assert.equal(getExtractionProviderMaxInputBytes(), 8192)
  })

  it("timeout adapter ≤ service", () => {
    process.env.ACQUISITION_EXTRACTION_TIMEOUT_MS = "10000"
    process.env.ACQUISITION_EXTRACTION_PROVIDER = "anthropic"
    process.env.ANTHROPIC_API_KEY = "sk"
    const c = getAnthropicPublicConfig()
    assert.ok(c.timeoutMs <= c.serviceTimeoutMs)
    assert.ok(c.timeoutMs < 10000)
    assert.equal(c.maxPromptBytes, c.maxInputBytes)
  })

  it("readAnthropicApiKey ne fuit pas via config publique", () => {
    process.env.ANTHROPIC_API_KEY = "sk-secret-value"
    assert.equal(readAnthropicApiKey(), "sk-secret-value")
    const c = getAnthropicPublicConfig()
    assert.equal(JSON.stringify(c).includes("sk-secret-value"), false)
  })
})
