/**
 * Helpers purs du script de recette fournisseurs réels Véhicules V3 (testables sans réseau) :
 * arguments, hygiène d'environnement, préfixe de recette strict, client Anthropic borné,
 * oracle d'adresses, description d'erreurs sans message fournisseur, redaction de la sortie.
 */
import { createHash } from "node:crypto"
import { isCloudinaryUploadApiError } from "@/lib/acquisition/attachments/attachment-storage.port"
import { mapAnthropicSdkError, type AnthropicExtractionClient } from "@/lib/acquisition/extraction/anthropic-extraction.client"
import { ANTHROPIC_EXTRACTION_MODEL_ALLOWLIST } from "@/lib/acquisition/extraction/anthropic-extraction.config"
import { MileageDomainError } from "@/lib/vehicules/mileage-domain"
import type { ImportCandidate } from "@/lib/vehicules/import-domain"
import { normalizeAddressText, type KnownAddress } from "./vehicle-v3-real-providers.fixtures"

/* ------------------------------------------------------------------ arguments */

export const ACK_PHRASE = "I_ACCEPT_REAL_PROVIDER_COSTS"
export const MAX_OCR_CALLS = 2
/** `recette-AAAAMMJJ-<suffixe aléatoire>` : unique par exécution, jamais le préfixe applicatif. */
export const PREFIX_SHAPE = /^recette-[0-9]{8}-[a-z0-9]{6,32}$/
export const FORBIDDEN_PREFIXES = new Set(["planificator", "test", "prod", "production", "staging"])

export type RunMode = "storage" | "ocr" | "fixtures"

export interface ParsedArgs {
  mode: RunMode
  ack: boolean
  prefix: string | null
  fixturePath: string | null
  /** Adresses attendues dans la fixture externe (--expect-address, répétable) ; oracle de la fixture générée sinon. */
  expectedAddresses: string[]
  dumpDir: string | null
  outPath: string | null
  /** 1 = image PNG seulement ; 2 = PNG puis PDF image-seule (défaut, plafond dur). */
  ocrCalls: 1 | 2
}

export type Refusal = { code: string; detail?: string }

export function parseArgs(argv: readonly string[]): { ok: true; args: ParsedArgs } | { ok: false; refusal: Refusal } {
  const args: ParsedArgs = { mode: "fixtures", ack: false, prefix: null, fixturePath: null, expectedAddresses: [], dumpDir: null, outPath: null, ocrCalls: 2 }
  let modeGiven = false
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = () => { const v = argv[i + 1]; if (v === undefined || v.startsWith("--")) return null; i++; return v }
    switch (flag) {
      case "--mode": { const v = value(); if (v !== "storage" && v !== "ocr" && v !== "fixtures") return { ok: false, refusal: { code: "ARG_MODE_INVALID" } }; args.mode = v; modeGiven = true; break }
      case "--ack": { const v = value(); args.ack = v === ACK_PHRASE; if (!args.ack) return { ok: false, refusal: { code: "ACK_INVALID" } }; break }
      case "--prefix": { const v = value(); if (!v) return { ok: false, refusal: { code: "ARG_PREFIX_MISSING" } }; args.prefix = v; break }
      case "--fixture": { const v = value(); if (!v) return { ok: false, refusal: { code: "ARG_FIXTURE_MISSING" } }; args.fixturePath = v; break }
      case "--expect-address": { const v = value(); if (!v || v.trim().length < 8) return { ok: false, refusal: { code: "ARG_EXPECT_ADDRESS_INVALID" } }; args.expectedAddresses.push(v.trim()); break }
      case "--dump": { const v = value(); if (!v) return { ok: false, refusal: { code: "ARG_DUMP_MISSING" } }; args.dumpDir = v; break }
      case "--out": { const v = value(); if (!v) return { ok: false, refusal: { code: "ARG_OUT_MISSING" } }; args.outPath = v; break }
      case "--ocr-calls": { const v = value(); if (v !== "1" && v !== "2") return { ok: false, refusal: { code: "ARG_OCR_CALLS_INVALID", detail: `max ${MAX_OCR_CALLS}` } }; args.ocrCalls = v === "1" ? 1 : 2; break }
      default: return { ok: false, refusal: { code: "ARG_UNKNOWN", detail: flag } }
    }
  }
  if (!modeGiven) return { ok: false, refusal: { code: "ARG_MODE_REQUIRED", detail: "--mode storage|ocr|fixtures" } }
  if (args.mode === "fixtures") {
    if (!args.dumpDir) return { ok: false, refusal: { code: "ARG_DUMP_REQUIRED" } }
    return { ok: true, args }
  }
  if (!args.ack) return { ok: false, refusal: { code: "ACK_REQUIRED", detail: `--ack ${ACK_PHRASE}` } }
  if (args.fixturePath && args.expectedAddresses.length < 2) return { ok: false, refusal: { code: "FIXTURE_EXPECT_ADDRESS_REQUIRED", detail: "--expect-address <adresse> (au moins deux)" } }
  if (!args.fixturePath && args.expectedAddresses.length) return { ok: false, refusal: { code: "EXPECT_ADDRESS_WITHOUT_FIXTURE" } }
  if (args.mode === "storage") {
    const prefixCheck = validateRunPrefix(args.prefix)
    if (prefixCheck) return { ok: false, refusal: prefixCheck }
  }
  return { ok: true, args }
}

export function validateRunPrefix(prefix: string | null): Refusal | null {
  if (!prefix) return { code: "PREFIX_REQUIRED", detail: "--prefix recette-AAAAMMJJ-<suffixe>" }
  if (FORBIDDEN_PREFIXES.has(prefix.toLowerCase())) return { code: "PREFIX_FORBIDDEN" }
  if (!PREFIX_SHAPE.test(prefix)) return { code: "PREFIX_SHAPE_INVALID", detail: PREFIX_SHAPE.source }
  return null
}

/* ------------------------------------------------------------------ hygiène d'environnement */

const CLOUDINARY_VARS = ["CLOUDINARY_URL", "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET", "CLOUDINARY_ACCOUNT_URL"]
const ANTHROPIC_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]
/** Jamais nécessaires : leur présence signale un environnement non épuré. */
const ALWAYS_FORBIDDEN = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "DATABASE_URL", "DIRECT_URL", "VEHICULE_V2_DATABASE_URL", "RESEND_API_KEY", "AUTH_SECRET", "NEXTAUTH_SECRET", "CRON_SECRET", "GOOGLE_CLIENT_SECRET", "AWS_SECRET_ACCESS_KEY"]

export function checkEnvironmentHygiene(mode: RunMode, env: NodeJS.ProcessEnv): Refusal | null {
  const defined = (name: string) => typeof env[name] === "string" && env[name]!.length > 0
  const forbidden = [...ALWAYS_FORBIDDEN, ...(mode === "storage" ? ANTHROPIC_VARS : mode === "ocr" ? CLOUDINARY_VARS : [...ANTHROPIC_VARS, ...CLOUDINARY_VARS])].filter(defined)
  if (forbidden.length) return { code: "ENV_NOT_MINIMAL", detail: forbidden.join(",") }
  if (mode === "ocr" && !defined("ANTHROPIC_API_KEY")) return { code: "ENV_ANTHROPIC_API_KEY_MISSING" }
  if (mode === "storage" && !CLOUDINARY_VARS.some(defined)) return { code: "ENV_CLOUDINARY_MISSING" }
  if (mode === "ocr") {
    const model = (env.ACQUISITION_EXTRACTION_MODEL ?? "").trim()
    if (model && !(ANTHROPIC_EXTRACTION_MODEL_ALLOWLIST as readonly string[]).includes(model)) return { code: "OCR_MODEL_NOT_ALLOWLISTED" }
  }
  return null
}

/* ------------------------------------------------------------------ client Anthropic borné */

export interface OcrUsage {
  calls: number
  attempted: number
  model: string | null
  inputTokens: number
  outputTokens: number
  stopReasons: string[]
  /** Plafond dur ; au-delà, l'appel est refusé localement sans contacter le fournisseur. */
  maxCalls: number
}

export function createUsageTracker(maxCalls = MAX_OCR_CALLS): OcrUsage {
  return { calls: 0, attempted: 0, model: null, inputTokens: 0, outputTokens: 0, stopReasons: [], maxCalls }
}

/**
 * Enveloppe le client réel : compte, plafonne, vérifie modèle allowlisté et max_tokens, relève
 * l'utilisation. Ne modifie ni la requête ni la réponse ; ne journalise jamais le contenu.
 */
export function createBoundedClient(inner: AnthropicExtractionClient, usage: OcrUsage): AnthropicExtractionClient {
  return {
    messagesCreate: async (body, options) => {
      usage.attempted += 1
      if (usage.calls >= usage.maxCalls) throw new MileageDomainError("OCR_CALL_BUDGET_EXCEEDED", 429)
      if (!(ANTHROPIC_EXTRACTION_MODEL_ALLOWLIST as readonly string[]).includes(body.model)) throw new MileageDomainError("OCR_MODEL_NOT_ALLOWLISTED", 400)
      if (typeof body.max_tokens !== "number" || body.max_tokens > 4096) throw new MileageDomainError("OCR_MAX_TOKENS_INVALID", 400)
      usage.calls += 1
      usage.model = body.model
      const response = await inner.messagesCreate(body, options)
      usage.inputTokens += response.usage?.input_tokens ?? 0
      usage.outputTokens += response.usage?.output_tokens ?? 0
      usage.stopReasons.push(String(response.stop_reason ?? "unknown"))
      return response
    },
  }
}

/* ------------------------------------------------------------------ oracle d'adresses */

export const normalizeText = normalizeAddressText

export interface AddressMatch { label: string; matched: boolean; candidateIndex: number | null; excerptPresent: boolean }

/** Chaque adresse connue doit apparaître (numéro, voie, code postal, ville) dans un candidat ; preuve non vide. */
export function matchKnownAddresses(candidates: readonly ImportCandidate[], known: readonly KnownAddress[]): AddressMatch[] {
  return known.map(expected => {
    const index = candidates.findIndex(candidate => {
      const haystack = ` ${normalizeText(`${candidate.address} ${candidate.excerpt}`)} `
      return expected.tokens.every(token => haystack.includes(` ${normalizeText(token)} `))
    })
    return { label: expected.label, matched: index >= 0, candidateIndex: index >= 0 ? index : null, excerptPresent: index >= 0 && candidates[index].excerpt.trim().length > 0 }
  })
}

export interface CandidateInvariants { total: number; allUnconfirmed: boolean; allWithoutCoordinates: boolean; allWithExcerpt: boolean }

export function candidateInvariants(candidates: readonly ImportCandidate[]): CandidateInvariants {
  return {
    total: candidates.length,
    allUnconfirmed: candidates.every(c => c.confirmed === false),
    allWithoutCoordinates: candidates.every(c => c.latitude === null && c.longitude === null),
    allWithExcerpt: candidates.every(c => c.excerpt.trim().length > 0),
  }
}

/* ------------------------------------------------------------------ erreurs sans fuite */

export interface SafeError { kind: string; code?: string; status?: number; httpCode?: number }

/** Forme sûre : jamais `message`, `stack`, corps ou en-têtes fournisseur. */
export function describeError(error: unknown): SafeError {
  if (error instanceof MileageDomainError) return { kind: "DOMAIN", code: error.code, status: error.status }
  if (isCloudinaryUploadApiError(error)) return { kind: "CLOUDINARY", httpCode: error.http_code }
  const anthropic = mapAnthropicSdkError(error)
  if (anthropic.kind !== "UNKNOWN") return { kind: `ANTHROPIC_${anthropic.kind}`, ...("status" in anthropic && anthropic.status !== undefined ? { status: anthropic.status } : {}) }
  if (error instanceof Error) {
    const code = /^[A-Z0-9_]{3,64}$/.test(error.message) ? error.message : undefined
    return { kind: error.constructor.name || "Error", ...(code ? { code } : {}) }
  }
  return { kind: typeof error }
}

/* ------------------------------------------------------------------ redaction */

/** Valeurs à masquer dans toute sortie : secrets, nom du cloud, URLs (signées ou non). */
export function collectSensitiveValues(env: NodeJS.ProcessEnv): string[] {
  const values = new Set<string>()
  for (const name of [...CLOUDINARY_VARS, ...ANTHROPIC_VARS, ...ALWAYS_FORBIDDEN]) {
    const value = env[name]
    if (typeof value === "string" && value.trim().length >= 4) values.add(value.trim())
  }
  const url = env.CLOUDINARY_URL?.trim()
  if (url) {
    try {
      const parsed = new URL(url)
      for (const part of [parsed.hostname, parsed.username, parsed.password]) if (part && part.length >= 4) values.add(decodeURIComponent(part))
    } catch { /* forme invalide : la valeur brute est déjà masquée */ }
  }
  return [...values].sort((a, b) => b.length - a.length)
}

export function redactOutput(text: string, sensitive: readonly string[]): string {
  let output = text.replace(/https?:\/\/[^\s"'<>)\]]+/gi, "[URL_REDACTED]")
  for (const value of sensitive) output = output.split(value).join("[REDACTED]")
  return output
}

export const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/* ------------------------------------------------------------------ rapport */

export type StepStatus = "PASS" | "FAIL" | "SKIP"

export interface StepReport { id: string; status: StepStatus; assertions: number; detail?: Record<string, unknown>; error?: SafeError }

export interface RunReport {
  script: "vehicle-v3-real-providers"
  version: 1
  mode: RunMode
  startedAt: string
  finishedAt: string | null
  runId: string
  prefix: string | null
  fixtures: Record<string, { bytes: number; sha256: string; source: "generated" | "file" }>
  steps: StepReport[]
  ocr: OcrUsage | null
  cleanup: { created: string[]; destroyed: string[]; leftovers: string[] } | null
  summary: { status: "PASS" | "FAIL" | "REFUSED"; passed: number; failed: number; skipped: number; assertions: number; refusal?: Refusal }
}

export function summarize(steps: readonly StepReport[], cleanupOk: boolean): RunReport["summary"] {
  const passed = steps.filter(s => s.status === "PASS").length
  const failed = steps.filter(s => s.status === "FAIL").length
  const skipped = steps.filter(s => s.status === "SKIP").length
  const assertions = steps.reduce((sum, s) => sum + s.assertions, 0)
  return { status: failed === 0 && cleanupOk ? "PASS" : "FAIL", passed, failed, skipped, assertions }
}
