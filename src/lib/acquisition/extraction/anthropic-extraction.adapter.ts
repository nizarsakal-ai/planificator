/**
 * PLAN-ACQ-005B-3 — AnthropicExtractionAdapter (ExtractionProviderPort).
 * Aucun Prisma / companyId / statut métier.
 */

import type {
  ContentBlockParam,
  Message,
  MessageCreateParamsNonStreaming,
  ToolChoiceTool,
} from "@anthropic-ai/sdk/resources/messages"
import {
  EXTRACTION_TOOL_NAME,
  getAnthropicPublicConfig,
  readAnthropicApiKey,
  type AnthropicPublicConfig,
} from "@/lib/acquisition/extraction/anthropic-extraction.config"
import { APIError, BadRequestError } from "@anthropic-ai/sdk"
import {
  createAnthropicExtractionClient,
  mapAnthropicSdkError,
  type AnthropicExtractionClient,
} from "@/lib/acquisition/extraction/anthropic-extraction.client"
import {
  buildAnthropicExtractionPrompt,
  buildAnthropicSystemPrompt,
} from "@/lib/acquisition/extraction/anthropic-extraction.prompt"
import {
  EXTRACTION_TOOL_DEFINITION,
  mapAnthropicRawToProviderResult,
} from "@/lib/acquisition/extraction/anthropic-extraction.schema"
import { ExtractionProviderError } from "@/lib/acquisition/extraction/extraction-provider.errors"
import type {
  AttachmentVisualInput,
  ExtractionProviderPort,
  ExtractionProviderResult,
  NormalizedExtractInput,
} from "@/lib/acquisition/extraction/extraction-provider.port"

export type AnthropicAdapterDeps = {
  client?: AnthropicExtractionClient
  config?: AnthropicPublicConfig
  /** Override sleep for tests. */
  sleep?: (ms: number) => Promise<void>
  log?: (event: string, payload?: Record<string, unknown>) => void
}

const TOOL_NAME = EXTRACTION_TOOL_NAME
const MAX_ADAPTER_RETRIES = 1
const BACKOFF_MS = 300
/** Minimum restant après backoff pour tenter un second appel. */
const MIN_RETRY_CALL_MS = 500

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function safeLog(
  log: AnthropicAdapterDeps["log"],
  event: string,
  payload?: Record<string, unknown>
): void {
  if (!log) return
  log(event, payload)
}

/**
 * Règle unique : exactement un bloc tool_use au total, au nom attendu.
 * Les blocs texte éventuels sont ignorés (jamais lus/loggés/persistés).
 */
function extractToolInput(message: Message, maxResponseBytes: number): unknown {
  const serialized = JSON.stringify(message.content)
  if (Buffer.byteLength(serialized, "utf8") > maxResponseBytes) {
    throw new ExtractionProviderError(
      "PROVIDER_INVALID_OUTPUT",
      "Réponse fournisseur surdimensionnée",
      false
    )
  }

  const toolBlocks = message.content.filter(
    (b): b is Extract<(typeof message.content)[number], { type: "tool_use" }> =>
      b.type === "tool_use"
  )

  if (toolBlocks.length !== 1) {
    throw new ExtractionProviderError(
      "PROVIDER_INVALID_OUTPUT",
      "Bloc tool structuré attendu introuvable ou ambigu",
      false
    )
  }

  const block = toolBlocks[0]
  if (block.name !== TOOL_NAME) {
    throw new ExtractionProviderError(
      "PROVIDER_INVALID_OUTPUT",
      "Bloc tool structuré attendu introuvable ou ambigu",
      false
    )
  }

  const input = block.input
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ExtractionProviderError(
      "PROVIDER_INVALID_OUTPUT",
      "Input tool invalide",
      false
    )
  }

  return input
}

/** Garde-fou adapter (le service borne déjà en amont). */
const MAX_VISUAL_BLOCKS = 5

/**
 * PLAN-ACQ-MULTIMODAL — Contenu user : JSON texte (inchangé) puis, pour chaque
 * pièce visuelle, un bloc texte JSON d'étiquette + bloc natif image/document.
 * Le nom de fichier n'est jamais concaténé hors JSON.stringify.
 */
export function buildAnthropicUserContent(
  userJson: string,
  visuals: AttachmentVisualInput[] | undefined
): string | ContentBlockParam[] {
  const list = (visuals ?? []).slice(0, MAX_VISUAL_BLOCKS)
  if (list.length === 0) return userJson
  const blocks: ContentBlockParam[] = [{ type: "text", text: userJson }]
  for (const v of list) {
    blocks.push({
      type: "text",
      text: JSON.stringify({ attachmentVisual: v.filename.slice(0, 255) }),
    })
    if (v.kind === "pdf") {
      blocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: v.base64 },
      })
    } else {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: v.mediaType, data: v.base64 },
      })
    }
  }
  return blocks
}

function isVisualInputRejection(error: unknown): boolean {
  if (error instanceof BadRequestError) return true
  if (error instanceof APIError && (error.status === 400 || error.status === 413)) return true
  return false
}

function throwMapped(mapped: ReturnType<typeof mapAnthropicSdkError>): never {
  switch (mapped.kind) {
    case "AUTH":
      throw new ExtractionProviderError(
        "PROVIDER_DISABLED",
        "Fournisseur Anthropic non autorisé",
        false
      )
    case "RATE_LIMIT":
    case "SERVER":
    case "NETWORK":
      throw new ExtractionProviderError(
        "PROVIDER_UNAVAILABLE",
        "Fournisseur Anthropic indisponible",
        true
      )
    case "TIMEOUT":
      throw new ExtractionProviderError(
        "PROVIDER_TIMEOUT",
        "Délai fournisseur dépassé",
        true
      )
    case "ABORT":
      // Abort (budget / signal) : non retryable — le budget est déjà consommé.
      throw new ExtractionProviderError(
        "PROVIDER_TIMEOUT",
        "Délai fournisseur dépassé",
        false
      )
    case "UNKNOWN":
    default:
      throw new ExtractionProviderError(
        "PROVIDER_INTERNAL_ERROR",
        "Erreur fournisseur interne",
        false
      )
  }
}

function isTransientMapped(
  mapped: ReturnType<typeof mapAnthropicSdkError>
): boolean {
  return (
    mapped.kind === "RATE_LIMIT" ||
    mapped.kind === "SERVER" ||
    mapped.kind === "NETWORK"
  )
}

export class AnthropicExtractionAdapter implements ExtractionProviderPort {
  /** PLAN-ACQ-MULTIMODAL — blocs natifs image / document supportés. */
  readonly supportsVisualInputs = true
  private readonly client: AnthropicExtractionClient
  private readonly config: AnthropicPublicConfig
  private readonly sleep: (ms: number) => Promise<void>
  private readonly log: AnthropicAdapterDeps["log"]

  constructor(deps: AnthropicAdapterDeps = {}) {
    const config = deps.config ?? getAnthropicPublicConfig()
    this.config = config
    this.sleep = deps.sleep ?? defaultSleep
    this.log = deps.log

    if (deps.client) {
      this.client = deps.client
    } else {
      const key = readAnthropicApiKey()
      if (!key || !config.configured || !config.model) {
        throw new ExtractionProviderError(
          "PROVIDER_DISABLED",
          "Anthropic non configuré",
          false
        )
      }
      this.client = createAnthropicExtractionClient(key)
    }
  }

  async extract(input: NormalizedExtractInput): Promise<ExtractionProviderResult> {
    const started = Date.now()
    const model = this.config.model
    if (!model) {
      throw new ExtractionProviderError("PROVIDER_DISABLED", "Modèle absent", false)
    }

    const prompt = buildAnthropicExtractionPrompt({
      subject: input.subject,
      body: input.normalizedText,
      attachmentMetadata: input.attachmentMetadata,
      maxPromptBytes: this.config.maxPromptBytes,
    })

    const extraWarnings: string[] = []
    if (prompt.truncated) {
      extraWarnings.push("INPUT_TRUNCATED_FOR_PROVIDER")
    }

    // Evidence uniquement contre subject/body réellement transmis (pas system, pas PJ).
    const haystack = [prompt.subjectSent, prompt.bodySent].filter(Boolean).join("\n")

    const toolChoice: ToolChoiceTool = {
      type: "tool",
      name: TOOL_NAME,
      disable_parallel_tool_use: true,
    }

    const visuals = (input.attachmentVisuals ?? []).slice(0, MAX_VISUAL_BLOCKS)
    let hasVisuals = visuals.length > 0

    const body: MessageCreateParamsNonStreaming = {
      model,
      max_tokens: this.config.maxTokens,
      temperature: 0,
      system: hasVisuals ? buildAnthropicSystemPrompt({ hasVisualAttachments: true }) : prompt.system,
      messages: [{ role: "user", content: buildAnthropicUserContent(prompt.user, visuals) }],
      tools: [EXTRACTION_TOOL_DEFINITION],
      tool_choice: toolChoice,
    }

    safeLog(this.log, "ANTHROPIC_EXTRACT_START", {
      provider: "anthropic",
      model,
      promptBytes: prompt.totalUserBytes,
      truncated: prompt.truncated,
      visualCount: visuals.length,
      visualBytes: visuals.reduce((n, v) => n + v.byteLength, 0),
    })

    let attempt = 0
    const deadline = started + this.config.timeoutMs

    while (attempt <= MAX_ADAPTER_RETRIES) {
      attempt++
      const remaining = deadline - Date.now()
      if (remaining <= 100) {
        throw new ExtractionProviderError("PROVIDER_TIMEOUT", "Budget timeout épuisé", false)
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), remaining)

      try {
        const message = await this.client.messagesCreate(body, {
          timeout: remaining,
          signal: controller.signal,
          maxRetries: 0,
        })

        const toolInput = extractToolInput(message, this.config.maxResponseBytes)
        let result: ExtractionProviderResult
        try {
          result = mapAnthropicRawToProviderResult({
            raw: toolInput,
            haystack,
            model,
            latencyMs: Date.now() - started,
            extraWarningCodes: extraWarnings,
            visualEvidenceAllowed: hasVisuals,
          })
        } catch {
          throw new ExtractionProviderError(
            "PROVIDER_INVALID_OUTPUT",
            "Sortie structurée invalide",
            false
          )
        }

        safeLog(this.log, "ANTHROPIC_EXTRACT_OK", {
          provider: "anthropic",
          model,
          latencyMs: result.providerMetadata.latencyMs,
          retryCount: attempt - 1,
          schemaValid: true,
          warningCount: result.warnings.length,
        })
        return result
      } catch (error) {
        if (error instanceof ExtractionProviderError) {
          safeLog(this.log, "ANTHROPIC_EXTRACT_FAIL", {
            provider: "anthropic",
            model,
            code: error.code,
            retryCount: attempt - 1,
          })
          throw error
        }

        // P1-3 — une pièce visuelle refusée par l'API (400 / 413 : taille, format,
        // dimensions) ne doit jamais faire échouer toute l'extraction : une seule
        // relance en texte seul, warning VISUAL_INPUTS_DROPPED (le service marque
        // alors les pièces concernées comme non lues).
        if (hasVisuals && isVisualInputRejection(error)) {
          hasVisuals = false
          body.system = prompt.system
          body.messages = [{ role: "user", content: prompt.user }]
          extraWarnings.push("VISUAL_INPUTS_DROPPED")
          safeLog(this.log, "ANTHROPIC_EXTRACT_VISUALS_DROPPED", { provider: "anthropic", model })
          attempt-- // relance dédiée, ne consomme pas le retry transitoire
          continue
        }

        const mapped = mapAnthropicSdkError(error)
        const canRetry =
          isTransientMapped(mapped) &&
          attempt <= MAX_ADAPTER_RETRIES &&
          Date.now() + BACKOFF_MS + MIN_RETRY_CALL_MS < deadline

        if (canRetry) {
          safeLog(this.log, "ANTHROPIC_EXTRACT_RETRY", {
            provider: "anthropic",
            model,
            kind: mapped.kind,
            attempt,
          })
          await this.sleep(BACKOFF_MS)
          continue
        }

        safeLog(this.log, "ANTHROPIC_EXTRACT_FAIL", {
          provider: "anthropic",
          model,
          kind: mapped.kind,
          retryCount: attempt - 1,
        })
        throwMapped(mapped)
      } finally {
        clearTimeout(timer)
      }
    }

    throw new ExtractionProviderError(
      "PROVIDER_INTERNAL_ERROR",
      "Erreur fournisseur interne",
      false
    )
  }
}

export function createAnthropicExtractionAdapter(
  deps?: AnthropicAdapterDeps
): AnthropicExtractionAdapter {
  return new AnthropicExtractionAdapter(deps)
}
