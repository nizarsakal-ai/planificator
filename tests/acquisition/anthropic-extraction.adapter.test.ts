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
import { ANTHROPIC_EXTRACTION_SYSTEM_PROMPT } from "@/lib/acquisition/extraction/anthropic-extraction.prompt"

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
