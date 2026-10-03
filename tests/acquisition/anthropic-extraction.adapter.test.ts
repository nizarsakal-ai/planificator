process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
  InternalServerError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
} from "@anthropic-ai/sdk"
import type { AnthropicPublicConfig } from "@/lib/acquisition/extraction/anthropic-extraction.config"
import { AnthropicExtractionAdapter } from "@/lib/acquisition/extraction/anthropic-extraction.adapter"
import { DEFAULT_ANTHROPIC_EXTRACTION_MODEL } from "@/lib/acquisition/extraction/anthropic-extraction.config"
import { EXTRACTION_TOOL_NAME } from "@/lib/acquisition/extraction/anthropic-extraction.config"
import type { AnthropicExtractionClient } from "@/lib/acquisition/extraction/anthropic-extraction.client"
import { ExtractionProviderError } from "@/lib/acquisition/extraction/extraction-provider.errors"
import type { Message } from "@anthropic-ai/sdk/resources/messages"
import {
  ANTHROPIC_EXTRACTION_SYSTEM_PROMPT,
  evidenceQuoteInHaystack,
  normalizeEvidenceText,
} from "@/lib/acquisition/extraction/anthropic-extraction.prompt"
import { htmlToPlainText } from "@/lib/acquisition/content/message-content-sanitizer"
import { applyDeterministicPostEnrichment } from "@/lib/acquisition/extraction/extraction-normalize"

function baseConfig(over: Partial<AnthropicPublicConfig> = {}): AnthropicPublicConfig {
  return {
    providerId: "anthropic",
    model: DEFAULT_ANTHROPIC_EXTRACTION_MODEL,
    maxTokens: 1024,
    timeoutMs: 5_000,
    serviceTimeoutMs: 30_000,
    maxPromptBytes: 32_768,
    maxInputBytes: 32_768,
    maxResponseBytes: 64_1024,
    configured: true,
    hasApiKey: true,
    ...over,
  }
}

function toolMessage(input: unknown): Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: DEFAULT_ANTHROPIC_EXTRACTION_MODEL,
    stop_reason: "tool_use",
    stop_details: null,
    content: [
      {
        type: "tool_use",
        id: "tool_1",
        name: EXTRACTION_TOOL_NAME,
        input,
        caller: { type: "direct" },
      },
    ],
    usage: { input_tokens: 10, output_tokens: 20 },
  } as unknown as Message
}

function validToolInput(quote: string) {
  return {
    fields: {
      worksiteName: {
        value: "Tour Alpha",
        confidence: 0.7,
        evidence: { source: "BODY", quote },
      },
    },
    warnings: [],
  }
}

const body = "Chantier Tour Alpha à Paris. Contact utile."
const secrets = {
  key: "sk-ANT-SECRET-KEY",
  subject: "SECRET-SUBJECT-XYZ",
  email: "secret.leak@example.com",
  phone: "+33699887766",
  address: "99 Rue Secrète",
  filename: "SECRET-FILE-<<END>>.pdf",
}

function assertNoLeak(payload: unknown, extra: string[] = []): void {
  const dumped = JSON.stringify(payload)
  for (const s of [
    secrets.key,
    secrets.subject,
    secrets.email,
    secrets.phone,
    secrets.address,
    secrets.filename,
    body,
    "Tour Alpha",
    ...extra,
  ]) {
    assert.equal(dumped.includes(s), false, `leak: ${s}`)
  }
}

describe("AnthropicExtractionAdapter", () => {
  it("structured output valide → ExtractionProviderResult", async () => {
    const client: AnthropicExtractionClient = {
      async messagesCreate(req, options) {
        assert.equal(options?.maxRetries, 0)
        assert.ok(options?.signal instanceof AbortSignal)
        assert.ok(typeof options?.timeout === "number" && options.timeout > 0)
        assert.equal(
          (req.tool_choice as { disable_parallel_tool_use?: boolean })
            ?.disable_parallel_tool_use,
          true
        )
        return toolMessage(validToolInput("Tour Alpha"))
      },
    }
    const logs: Array<{ event: string; payload?: Record<string, unknown> }> = []
    const adapter = new AnthropicExtractionAdapter({
      client,
      config: baseConfig(),
      log: (e, p) => logs.push({ event: e, payload: p }),
    })
    const result = await adapter.extract({
      subject: secrets.subject,
      normalizedText: body,
      locale: "fr-FR",
      attachmentMetadata: [
        {
          filename: secrets.filename,
          mimeType: "application/pdf",
          category: "PLAN",
          sizeBytes: 1,
        },
      ],
      extractionSchemaVersion: "1",
    })
    assert.equal(result.providerMetadata.providerId, "anthropic")
    assert.ok(result.fields.worksiteName)
    assert.ok((result.fields.worksiteName.confidence as number) <= 0.85)
    assertNoLeak(logs)
  })

  it("texte libre + un seul tool_use → ignore texte, accepte tool", async () => {
    const client: AnthropicExtractionClient = {
      async messagesCreate() {
        const m = toolMessage(validToolInput("Tour Alpha"))
        return {
          ...m,
          content: [
            { type: "text", text: "ignore this free text with " + secrets.email },
            ...(m.content as object[]),
          ],
        } as unknown as Message
      },
    }
    const logs: Array<{ event: string; payload?: Record<string, unknown> }> = []
    const adapter = new AnthropicExtractionAdapter({
      client,
      config: baseConfig(),
      log: (e, p) => logs.push({ event: e, payload: p }),
    })
    const result = await adapter.extract({
      subject: null,
      normalizedText: body,
      locale: "fr-FR",
      attachmentMetadata: [],
      extractionSchemaVersion: "1",
    })
    assert.ok(result.fields.worksiteName)
    assertNoLeak(logs, [secrets.email])
  })

  it("champ inconnu rejeté", async () => {
    const client: AnthropicExtractionClient = {
      async messagesCreate() {
        return toolMessage({
          fields: { evilField: { value: "x", confidence: 0.5 } },
          warnings: [],
        })
      },
    }
    const adapter = new AnthropicExtractionAdapter({ client, config: baseConfig() })
    await assert.rejects(
      () =>
        adapter.extract({
          subject: null,
          normalizedText: body,
          locale: "fr-FR",
          attachmentMetadata: [],
          extractionSchemaVersion: "1",
        }),
      (e: unknown) => e instanceof ExtractionProviderError && e.code === "PROVIDER_INVALID_OUTPUT"
    )
  })

  it("zéro bloc tool → INVALID_OUTPUT", async () => {
    const client: AnthropicExtractionClient = {
      async messagesCreate() {
        return {
          ...toolMessage({}),
          content: [{ type: "text", text: "hello" }],
        } as unknown as Message
      },
    }
    const adapter = new AnthropicExtractionAdapter({ client, config: baseConfig() })
    await assert.rejects(
      () =>
        adapter.extract({
          subject: null,
          normalizedText: body,
          locale: "fr-FR",
          attachmentMetadata: [],
          extractionSchemaVersion: "1",
        }),
      (e: unknown) => e instanceof ExtractionProviderError && e.code === "PROVIDER_INVALID_OUTPUT"
    )
  })

  it("plusieurs blocs tool → INVALID_OUTPUT", async () => {
    const client: AnthropicExtractionClient = {
      async messagesCreate() {
        const m = toolMessage(validToolInput("Tour Alpha"))
        return {
          ...m,
          content: [
            ...(m.content as object[]),
            {
              type: "tool_use",
              id: "tool_2",
              name: EXTRACTION_TOOL_NAME,
              input: validToolInput("Tour Alpha"),
              caller: { type: "direct" },
            },
          ],
        } as unknown as Message
      },
    }
    const adapter = new AnthropicExtractionAdapter({ client, config: baseConfig() })
    await assert.rejects(
      () =>
        adapter.extract({
          subject: null,
          normalizedText: body,
          locale: "fr-FR",
          attachmentMetadata: [],
          extractionSchemaVersion: "1",
        }),
      (e: unknown) =>
        e instanceof ExtractionProviderError &&
        e.code === "PROVIDER_INVALID_OUTPUT" &&
        e.retryable === false
    )
  })

  it("un tool attendu + un tool étranger → INVALID_OUTPUT", async () => {
    const logs: Array<{ event: string; payload?: Record<string, unknown> }> = []
    const client: AnthropicExtractionClient = {
      async messagesCreate() {
        const m = toolMessage(validToolInput("Tour Alpha"))
        return {
          ...m,
          content: [
            ...(m.content as object[]),
            {
              type: "tool_use",
              id: "tool_x",
              name: "other_tool",
              input: { evil: secrets.email },
              caller: { type: "direct" },
            },
          ],
        } as unknown as Message
      },
    }
    const adapter = new AnthropicExtractionAdapter({
      client,
      config: baseConfig(),
      log: (e, p) => logs.push({ event: e, payload: p }),
    })
    await assert.rejects(
      () =>
        adapter.extract({
          subject: null,
          normalizedText: body,
          locale: "fr-FR",
          attachmentMetadata: [],
          extractionSchemaVersion: "1",
        }),
      (e: unknown) =>
        e instanceof ExtractionProviderError &&
        e.code === "PROVIDER_INVALID_OUTPUT" &&
        e.retryable === false &&
        !JSON.stringify(e).includes(secrets.email)
    )
    assertNoLeak(logs, [secrets.email])
  })

  it("uniquement un tool étranger → INVALID_OUTPUT", async () => {
    const client: AnthropicExtractionClient = {
      async messagesCreate() {
        return {
          ...toolMessage({}),
          content: [
            {
              type: "tool_use",
              id: "tool_x",
              name: "wrong_tool",
              input: { x: 1 },
              caller: { type: "direct" },
            },
          ],
        } as unknown as Message
      },
    }
    const adapter = new AnthropicExtractionAdapter({ client, config: baseConfig() })
    await assert.rejects(
      () =>
        adapter.extract({
          subject: null,
          normalizedText: body,
          locale: "fr-FR",
          attachmentMetadata: [],
          extractionSchemaVersion: "1",
        }),
      (e: unknown) =>
        e instanceof ExtractionProviderError &&
        e.code === "PROVIDER_INVALID_OUTPUT" &&
        e.retryable === false
    )
  })

  it("input tool non objet → INVALID_OUTPUT", async () => {
    const client: AnthropicExtractionClient = {
      async messagesCreate() {
        return toolMessage("not-an-object")
      },
    }
    const adapter = new AnthropicExtractionAdapter({ client, config: baseConfig() })
    await assert.rejects(
      () =>
        adapter.extract({
          subject: null,
          normalizedText: body,
          locale: "fr-FR",
          attachmentMetadata: [],
          extractionSchemaVersion: "1",
        }),
      (e: unknown) => e instanceof ExtractionProviderError && e.code === "PROVIDER_INVALID_OUTPUT"
    )
  })

  it("JSON/schema invalide", async () => {
    const client: AnthropicExtractionClient = {
      async messagesCreate() {
        return toolMessage({ fields: "nope", warnings: [] })
      },
    }
    const adapter = new AnthropicExtractionAdapter({ client, config: baseConfig() })
    await assert.rejects(
      () =>
        adapter.extract({
          subject: null,
          normalizedText: body,
          locale: "fr-FR",
          attachmentMetadata: [],
          extractionSchemaVersion: "1",
        }),
      (e: unknown) => e instanceof ExtractionProviderError && e.code === "PROVIDER_INVALID_OUTPUT"
    )
  })

  it("réponse surdimensionnée", async () => {
    const client: AnthropicExtractionClient = {
      async messagesCreate() {
        return toolMessage(validToolInput("Tour Alpha"))
      },
    }
    const adapter = new AnthropicExtractionAdapter({
      client,
      config: baseConfig({ maxResponseBytes: 10 }),
    })
    await assert.rejects(
      () =>
        adapter.extract({
          subject: null,
          normalizedText: body,
          locale: "fr-FR",
          attachmentMetadata: [],
          extractionSchemaVersion: "1",
        }),
      (e: unknown) => e instanceof ExtractionProviderError && e.code === "PROVIDER_INVALID_OUTPUT"
    )
  })

  it("401 AuthenticationError → PROVIDER_DISABLED non retryable", async () => {
    let n = 0
    const logs: Array<{ event: string; payload?: Record<string, unknown> }> = []
    const client: AnthropicExtractionClient = {
      async messagesCreate() {
        n++
        throw new AuthenticationError(401, {}, "secret-sdk-auth", new Headers(), "authentication_error")
      },
    }
    const adapter = new AnthropicExtractionAdapter({
      client,
      config: baseConfig(),
      log: (e, p) => logs.push({ event: e, payload: p }),
    })
    await assert.rejects(
      () =>
        adapter.extract({
          subject: secrets.subject,
          normalizedText: body,
          locale: "fr-FR",
          attachmentMetadata: [],
          extractionSchemaVersion: "1",
        }),
      (e: unknown) =>
        e instanceof ExtractionProviderError &&
        e.code === "PROVIDER_DISABLED" &&
        e.retryable === false &&
        !String(e.message).includes("secret-sdk")
    )
    assert.equal(n, 1)
    assertNoLeak(logs, ["secret-sdk-auth"])
  })

  it("403 PermissionDeniedError → PROVIDER_DISABLED non retryable", async () => {
    let n = 0
    const client: AnthropicExtractionClient = {
      async messagesCreate() {
        n++
        throw new PermissionDeniedError(403, {}, "secret-forbidden", new Headers(), "permission_error")
      },
    }
    const adapter = new AnthropicExtractionAdapter({ client, config: baseConfig() })
    await assert.rejects(
      () =>
        adapter.extract({
          subject: null,
          normalizedText: body,
          locale: "fr-FR",
          attachmentMetadata: [],
          extractionSchemaVersion: "1",
        }),
      (e: unknown) =>
        e instanceof ExtractionProviderError &&
        e.code === "PROVIDER_DISABLED" &&
        e.retryable === false &&
        !String(e.message).includes("secret-forbidden")
    )
    assert.equal(n, 1)
  })

  it("429 puis succès (1 retry, maxRetries=0)", async () => {
    let n = 0
    const client: AnthropicExtractionClient = {
      async messagesCreate(_b, options) {
        assert.equal(options?.maxRetries, 0)
        n++
        if (n === 1) throw new RateLimitError(429, {}, "rate", new Headers(), "rate_limit_error")
        return toolMessage(validToolInput("Tour Alpha"))
      },
    }
    const adapter = new AnthropicExtractionAdapter({
      client,
      config: baseConfig(),
      sleep: async () => undefined,
    })
    const result = await adapter.extract({
      subject: null,
      normalizedText: body,
      locale: "fr-FR",
      attachmentMetadata: [],
      extractionSchemaVersion: "1",
    })
    assert.ok(result.fields.worksiteName)
    assert.equal(n, 2)
  })

  it("429 avec budget insuffisant → pas de second appel", async () => {
    let n = 0
    const client: AnthropicExtractionClient = {
      async messagesCreate() {
        n++
        throw new RateLimitError(429, {}, "rate", new Headers(), "rate_limit_error")
      },
    }
    const adapter = new AnthropicExtractionAdapter({
      client,
      config: baseConfig({ timeoutMs: 400 }),
      sleep: async () => undefined,
    })
    await assert.rejects(
      () =>
        adapter.extract({
          subject: null,
          normalizedText: body,
          locale: "fr-FR",
          attachmentMetadata: [],
          extractionSchemaVersion: "1",
        }),
      (e: unknown) =>
        e instanceof ExtractionProviderError && e.code === "PROVIDER_UNAVAILABLE"
    )
    assert.equal(n, 1)
  })

  it("5xx puis succès", async () => {
    let n = 0
    const client: AnthropicExtractionClient = {
      async messagesCreate() {
        n++
        if (n === 1) throw new InternalServerError(500, {}, "err", new Headers(), "api_error")
        return toolMessage(validToolInput("Tour Alpha"))
      },
    }
    const adapter = new AnthropicExtractionAdapter({
      client,
      config: baseConfig(),
      sleep: async () => undefined,
    })
    const result = await adapter.extract({
      subject: null,
      normalizedText: body,
      locale: "fr-FR",
      attachmentMetadata: [],
      extractionSchemaVersion: "1",
    })
    assert.ok(result.fields.worksiteName)
    assert.equal(n, 2)
  })

  it("network error → UNAVAILABLE retryable", async () => {
    const client: AnthropicExtractionClient = {
      async messagesCreate() {
        throw new APIConnectionError({ message: "net-secret" })
      },
    }
    const adapter = new AnthropicExtractionAdapter({
      client,
      config: baseConfig({ timeoutMs: 400 }),
      sleep: async () => undefined,
    })
    await assert.rejects(
      () =>
        adapter.extract({
          subject: null,
          normalizedText: body,
          locale: "fr-FR",
          attachmentMetadata: [],
          extractionSchemaVersion: "1",
        }),
      (e: unknown) =>
        e instanceof ExtractionProviderError &&
        e.code === "PROVIDER_UNAVAILABLE" &&
        e.retryable === true &&
        !String(e.message).includes("net-secret")
    )
  })

  it("APIConnectionTimeoutError → PROVIDER_TIMEOUT retryable", async () => {
    const client: AnthropicExtractionClient = {
      async messagesCreate() {
        throw new APIConnectionTimeoutError({ message: "timeout-secret" })
      },
    }
    const adapter = new AnthropicExtractionAdapter({ client, config: baseConfig() })
    await assert.rejects(
      () =>
        adapter.extract({
          subject: null,
          normalizedText: body,
          locale: "fr-FR",
          attachmentMetadata: [],
          extractionSchemaVersion: "1",
        }),
      (e: unknown) =>
        e instanceof ExtractionProviderError &&
        e.code === "PROVIDER_TIMEOUT" &&
        e.retryable === true &&
        !String(e.message).includes("timeout-secret")
    )
  })

  it("APIUserAbortError → PROVIDER_TIMEOUT non retryable", async () => {
    let n = 0
    const client: AnthropicExtractionClient = {
      async messagesCreate() {
        n++
        throw new APIUserAbortError()
      },
    }
    const adapter = new AnthropicExtractionAdapter({
      client,
      config: baseConfig(),
      sleep: async () => undefined,
    })
    await assert.rejects(
      () =>
        adapter.extract({
          subject: null,
          normalizedText: body,
          locale: "fr-FR",
          attachmentMetadata: [],
          extractionSchemaVersion: "1",
        }),
      (e: unknown) =>
        e instanceof ExtractionProviderError &&
        e.code === "PROVIDER_TIMEOUT" &&
        e.retryable === false
    )
    assert.equal(n, 1)
  })

  it("Error générique / TypeError / objet → PROVIDER_INTERNAL_ERROR non retryable", async () => {
    for (const err of [
      new Error("secret-generic-message"),
      new TypeError("secret-type-error"),
      { weird: "secret-object-reject" },
    ]) {
      let n = 0
      const client: AnthropicExtractionClient = {
        async messagesCreate() {
          n++
          throw err
        },
      }
      const adapter = new AnthropicExtractionAdapter({
        client,
        config: baseConfig(),
        sleep: async () => undefined,
      })
      await assert.rejects(
        () =>
          adapter.extract({
            subject: null,
            normalizedText: body,
            locale: "fr-FR",
            attachmentMetadata: [],
            extractionSchemaVersion: "1",
          }),
        (e: unknown) =>
          e instanceof ExtractionProviderError &&
          e.code === "PROVIDER_INTERNAL_ERROR" &&
          e.retryable === false &&
          !JSON.stringify(e).includes("secret-")
      )
      assert.equal(n, 1)
    }
  })

  it("INPUT_TRUNCATED_FOR_PROVIDER si dépassement — evidence hors trunc rejetée", async () => {
    const marker = "REF-HEAD"
    const text = `${marker} ${"é".repeat(5000)} TAIL-SHOULD-DROP`
    const client: AnthropicExtractionClient = {
      async messagesCreate(req) {
        const user = String((req.messages[0] as { content: string }).content)
        assert.ok(Buffer.byteLength(user, "utf8") <= 1200)
        const parsed = JSON.parse(user) as { emailBody: string }
        assert.equal(parsed.emailBody.includes("TAIL-SHOULD-DROP"), false)
        return toolMessage({
          fields: {
            consultationReference: {
              value: "REF-HEAD",
              confidence: 0.6,
              evidence: { source: "BODY", quote: marker },
            },
            worksiteName: {
              value: "Tail",
              confidence: 0.6,
              evidence: { source: "BODY", quote: "TAIL-SHOULD-DROP" },
            },
          },
          warnings: [],
        })
      },
    }
    const adapter = new AnthropicExtractionAdapter({
      client,
      config: baseConfig({ maxPromptBytes: 1200 }),
    })
    const result = await adapter.extract({
      subject: null,
      normalizedText: text,
      locale: "fr-FR",
      attachmentMetadata: [],
      extractionSchemaVersion: "1",
    })
    assert.ok(result.warnings.filter((w) => w.code === "INPUT_TRUNCATED_FOR_PROVIDER").length === 1)
    assert.ok(result.fields.consultationReference)
    assert.equal(result.fields.worksiteName, undefined)
  })

  it("quote uniquement dans system prompt → rejet champ fort", async () => {
    const onlyInSystem = "extract_worksite_fields"
    assert.ok(ANTHROPIC_EXTRACTION_SYSTEM_PROMPT.includes(onlyInSystem))
    const client: AnthropicExtractionClient = {
      async messagesCreate() {
        return toolMessage({
          fields: {
            worksiteName: {
              value: "X",
              confidence: 0.7,
              evidence: { source: "BODY", quote: onlyInSystem },
            },
          },
          warnings: [],
        })
      },
    }
    const adapter = new AnthropicExtractionAdapter({ client, config: baseConfig() })
    const result = await adapter.extract({
      subject: null,
      normalizedText: "Aucun outil ici",
      locale: "fr-FR",
      attachmentMetadata: [],
      extractionSchemaVersion: "1",
    })
    assert.equal(result.fields.worksiteName, undefined)
  })

  it("evidence casse / espaces acceptée", async () => {
    const client: AnthropicExtractionClient = {
      async messagesCreate() {
        return toolMessage(validToolInput("tour   alpha"))
      },
    }
    const adapter = new AnthropicExtractionAdapter({ client, config: baseConfig() })
    const result = await adapter.extract({
      subject: null,
      normalizedText: "Chantier Tour Alpha à Paris",
      locale: "fr-FR",
      attachmentMetadata: [],
      extractionSchemaVersion: "1",
    })
    assert.ok(result.fields.worksiteName)
  })

  it("champ fort sans evidence omis", async () => {
    const client: AnthropicExtractionClient = {
      async messagesCreate() {
        return toolMessage({
          fields: {
            worksiteName: { value: "Inventé", confidence: 0.9 },
            consultationReference: {
              value: "REF-9",
              confidence: 0.6,
              evidence: { source: "BODY", quote: "REF-9" },
            },
          },
          warnings: [],
        })
      },
    }
    const adapter = new AnthropicExtractionAdapter({ client, config: baseConfig() })
    const result = await adapter.extract({
      subject: null,
      normalizedText: "Dossier REF-9 uniquement",
      locale: "fr-FR",
      attachmentMetadata: [],
      extractionSchemaVersion: "1",
    })
    assert.equal(result.fields.worksiteName, undefined)
    assert.ok(result.fields.consultationReference)
  })

  it("confidence hors bornes rejetée", async () => {
    const client: AnthropicExtractionClient = {
      async messagesCreate() {
        return toolMessage({
          fields: {
            worksiteName: {
              value: "Tour Alpha",
              confidence: 1.5,
              evidence: { source: "BODY", quote: "Tour Alpha" },
            },
          },
          warnings: [],
        })
      },
    }
    const adapter = new AnthropicExtractionAdapter({ client, config: baseConfig() })
    await assert.rejects(
      () =>
        adapter.extract({
          subject: null,
          normalizedText: body,
          locale: "fr-FR",
          attachmentMetadata: [],
          extractionSchemaVersion: "1",
        }),
      (e: unknown) => e instanceof ExtractionProviderError && e.code === "PROVIDER_INVALID_OUTPUT"
    )
  })

  it("quote >120 rejetée", async () => {
    const longQuote = "x".repeat(121)
    const client: AnthropicExtractionClient = {
      async messagesCreate() {
        return toolMessage({
          fields: {
            worksiteName: {
              value: "X",
              confidence: 0.5,
              evidence: { source: "BODY", quote: longQuote },
            },
          },
          warnings: [],
        })
      },
    }
    const adapter = new AnthropicExtractionAdapter({ client, config: baseConfig() })
    await assert.rejects(
      () =>
        adapter.extract({
          subject: null,
          normalizedText: longQuote,
          locale: "fr-FR",
          attachmentMetadata: [],
          extractionSchemaVersion: "1",
        }),
      (e: unknown) => e instanceof ExtractionProviderError && e.code === "PROVIDER_INVALID_OUTPUT"
    )
  })

  it("warning libre hostile non persisté", async () => {
    const secret = "sk-LEAK-EMAIL-BODY"
    const client: AnthropicExtractionClient = {
      async messagesCreate() {
        return toolMessage({
          fields: {
            consultationReference: {
              value: "REF-1",
              confidence: 0.5,
              evidence: { source: "BODY", quote: "REF-1" },
            },
          },
          warnings: [{ code: "UNKNOWN_EVIL", field: secret }],
        })
      },
    }
    const logs: Array<{ event: string; payload?: Record<string, unknown> }> = []
    const adapter = new AnthropicExtractionAdapter({
      client,
      config: baseConfig(),
      log: (e, p) => logs.push({ event: e, payload: p }),
    })
    const result = await adapter.extract({
      subject: null,
      normalizedText: "Référence REF-1",
      locale: "fr-FR",
      attachmentMetadata: [],
      extractionSchemaVersion: "1",
    })
    assert.ok(result.warnings.some((w) => w.code === "PROVIDER_PARTIAL_RESULT"))
    assert.equal(JSON.stringify(result.warnings).includes(secret), false)
    assert.equal(JSON.stringify(logs).includes(secret), false)
  })

  it("invalid output → aucun retry", async () => {
    let n = 0
    const client: AnthropicExtractionClient = {
      async messagesCreate() {
        n++
        return toolMessage({ fields: "bad", warnings: [] })
      },
    }
    const adapter = new AnthropicExtractionAdapter({
      client,
      config: baseConfig(),
      sleep: async () => undefined,
    })
    await assert.rejects(
      () =>
        adapter.extract({
          subject: null,
          normalizedText: body,
          locale: "fr-FR",
          attachmentMetadata: [],
          extractionSchemaVersion: "1",
        }),
      (e: unknown) => e instanceof ExtractionProviderError && e.code === "PROVIDER_INVALID_OUTPUT"
    )
    assert.equal(n, 1)
  })
})

describe("AnthropicExtractionAdapter — strong-field evidence across line breaks", () => {
  const HTML = "<p>Adresse du chantier :<br>12 rue Exemple<br>75001 Paris</p>"

  function addressClient(quote: string): AnthropicExtractionClient {
    return {
      async messagesCreate() {
        return toolMessage({
          fields: {
            address: {
              value: "12 rue Exemple",
              confidence: 0.8,
              evidence: { source: "BODY", quote },
            },
            city: {
              value: "Paris",
              confidence: 0.8,
              evidence: { source: "BODY", quote: "Paris" },
            },
          },
          warnings: [],
        })
      },
    }
  }

  async function extractAddress(normalizedText: string, quote: string) {
    const adapter = new AnthropicExtractionAdapter({ client: addressClient(quote), config: baseConfig() })
    const result = await adapter.extract({
      subject: null,
      normalizedText,
      locale: "fr-FR",
      attachmentMetadata: [],
      extractionSchemaVersion: "1",
    })
    return { normalizedText, result }
  }

  function extractFromHtml(quote: string) {
    return extractAddress(htmlToPlainText(HTML), quote)
  }

  it("regression — single-line quote of a multiline sanitized address keeps the address", async () => {
    const { normalizedText, result } = await extractFromHtml("12 rue Exemple 75001 Paris")
    // Précondition : le sanitizer réel produit bien l'adresse sur plusieurs lignes.
    assert.ok(normalizedText.includes("Adresse du chantier :\n12 rue Exemple\n75001 Paris"))
    assert.equal(result.fields.city?.value, "Paris")
    // Comportement souhaité : même adresse, seuls les sauts de ligne diffèrent → conservée.
    assert.ok(result.fields.address, "address dropped: single-line quote vs multiline source")
    assert.equal(result.fields.address.value, "12 rue Exemple")
  })

  it("control — exact multiline quote is kept; a quote absent from the source is still dropped", async () => {
    const exact = await extractFromHtml("12 rue Exemple\n75001 Paris")
    assert.equal(exact.result.fields.address?.value, "12 rue Exemple")

    const absent = await extractFromHtml("99 avenue Inexistante 13000 Marseille")
    assert.equal(absent.result.fields.address, undefined)
    assert.equal(absent.result.fields.city?.value, "Paris")
  })

  it("adapter keeps the address when only the whitespace representation differs (CRLF / LF / runs / PDF wrap)", async () => {
    const cases: Array<[string, string]> = [
      ["12 rue Exemple\r\n75001 Paris", "12 rue Exemple 75001 Paris"],
      ["12 rue Exemple\r75001 Paris", "12 rue Exemple\n75001 Paris"],
      ["12 rue Exemple 75001 Paris", "12 rue Exemple\n75001 Paris"],
      ["12  \t rue\n\n  Exemple \r\n 75001\tParis", "12 rue Exemple 75001 Paris"],
      ["Chantier : 12 rue de la\nGrande Exemple 75001 Paris", "12 rue de la Grande Exemple"],
    ]
    for (const [source, quote] of cases) {
      const { result } = await extractAddress(source, quote)
      assert.equal(result.fields.address?.value, "12 rue Exemple", JSON.stringify([source, quote]))
    }
  })

  it("adapter still drops the address for real textual differences (punctuation, apostrophe, missing space)", async () => {
    const cases: Array<[string, string]> = [
      ["12 rue Exemple\n75001 Paris", "12 rue Exemple, 75001 Paris"],
      ["12 rue Exemple, 75001 Paris", "12 rue Exemple 75001 Paris"],
      ["12 rue de l’Eglise 75001 Paris", "12 rue de l'Eglise 75001 Paris"],
      ["12 rue Exemple 75001 Paris", "12 rue Exemple 75001 Paris."],
      ["12 rue Exem-\nple 75001 Paris", "12 rue Exemple 75001 Paris"],
      ["12 rue Exemple\n75001 Paris", "12rue Exemple 75001 Paris"],
    ]
    for (const [source, quote] of cases) {
      const { result } = await extractAddress(source, quote)
      assert.equal(result.fields.address, undefined, JSON.stringify([source, quote]))
    }
  })

  it("matcher: only whitespace representation is neutralised", () => {
    const accepted: Array<[string, string]> = [
      ["12 rue Exemple\n75001 Paris", "12 rue Exemple 75001 Paris"],
      ["12 rue Exemple\r\n75001 Paris", "12 rue Exemple\n75001 Paris"],
      ["12 rue Exemple\r\n75001 Paris", "12 rue Exemple 75001 Paris"],
      ["12\t\t rue \n\n\n Exemple", "12 rue Exemple"],
      ["12 rue Exemple", "12 rue Exemple"],
      ["12 rue Exemple", "12 rue Exemple"],
      ["12 rue Exemple\n75001 Paris", "12 rue Exemple\n75001 Paris"],
      ["12 RUE EXEMPLE\n75001 PARIS", "12 rue exemple 75001 paris"],
    ]
    for (const [hay, quote] of accepted) {
      assert.equal(evidenceQuoteInHaystack(hay, quote), true, JSON.stringify([hay, quote]))
    }
    const rejected: Array<[string, string]> = [
      ["12 rue Exemple\n75001 Paris", "12 rue Exemple, 75001 Paris"],
      ["12 rue Exemple; 75001 Paris", "12 rue Exemple 75001 Paris"],
      ["12 rue de l’Eglise", "12 rue de l'Eglise"],
      ["12 rue Exemple", "12 rue Exemple."],
      ["12 rue Exemple\n75001 Paris", "99 avenue Inexistante"],
      ["12 rue Exemple\n75001 Paris", "12rue Exemple"],
      ["chantier\n de \n Paris", " \n de \n "],
      ["accès\nà Paris", "\nà\n"],
    ]
    for (const [hay, quote] of rejected) {
      assert.equal(evidenceQuoteInHaystack(hay, quote), false, JSON.stringify([hay, quote]))
    }
    assert.equal(normalizeEvidenceText(" 12 \r\n\t rue \n Exemple  "), "12 rue exemple")
  })

  it("cancellation evidence: same phrase across a line break is now valid evidence; triple guard unchanged", () => {
    const baseFields = {
      worksiteName: "Site",
      clientName: null,
      clientEmail: null,
      clientPhone: null,
      contactName: null,
      contactEmail: null,
      contactPhone: null,
      address: null,
      postalCode: null,
      city: null,
      requestedStartDate: null,
      requestedEndDate: null,
      clientConsultationDate: null,
      consultationReference: null,
      description: null,
      attachmentClassifications: [],
      interventionNature: null,
      constraints: null,
      clientReference: null,
      requestClassification: "CANCELLED_CONSULTATION" as const,
      estimatedDurationHours: null,
      endClientName: null,
      requestedWeekNumber: null,
      requestedWeekYear: null,
    }
    const enrich = (body: string, quote: string) =>
      applyDeterministicPostEnrichment(
        {
          fields: { ...baseFields },
          confidenceData: {},
          evidenceData: { requestClassification: { source: "BODY", quote } },
          warnings: [],
          providerId: "anthropic",
          model: "t",
        },
        { subject: null, body }
      )

    // Même phrase, coupée par un saut de ligne dans la source : evidence valide + corroboration → cancel.
    const wrapped = enrich("Bonjour,\ncette consultation\nest annulée.", "cette consultation est annulée")
    assert.equal(wrapped.fields.requestClassification, "CANCELLED_CONSULTATION")
    assert.ok(wrapped.warnings.some((w) => w.code === "CONSULTATION_CANCELLED" && w.blocking))

    // Quote absente de la source : toujours déclassée, jamais de cancel.
    const absent = enrich("Bonjour,\ncette consultation\nest annulée.", "le projet est annulé")
    assert.equal(absent.fields.requestClassification, "CONSULTATION")
    assert.ok(!absent.warnings.some((w) => w.code === "CONSULTATION_CANCELLED"))

    // Evidence valide mais sans corroboration textuelle : toujours déclassée.
    const noCorroboration = enrich("Merci de chiffrer\nla consultation.", "chiffrer la consultation")
    assert.equal(noCorroboration.fields.requestClassification, "CONSULTATION")
    assert.ok(!noCorroboration.warnings.some((w) => w.code === "CONSULTATION_CANCELLED"))
  })
})
