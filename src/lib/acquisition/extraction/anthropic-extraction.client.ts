/**
 * PLAN-ACQ-005B-3 — Wrapper SDK Anthropic (testable, sans logique métier).
 */

import Anthropic from "@anthropic-ai/sdk"
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages"
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  AuthenticationError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk"

export type AnthropicMessagesCreateFn = (
  body: MessageCreateParamsNonStreaming,
  options?: { timeout?: number; signal?: AbortSignal; maxRetries?: number }
) => Promise<Message>

export type AnthropicExtractionClient = {
  messagesCreate: AnthropicMessagesCreateFn
}

export type AnthropicMappedError =
  | { kind: "AUTH"; status?: number }
  | { kind: "RATE_LIMIT"; status?: number }
  | { kind: "SERVER"; status?: number }
  | { kind: "TIMEOUT" }
  | { kind: "NETWORK" }
  | { kind: "ABORT" }
  | { kind: "UNKNOWN" }

/**
 * Mappe les erreurs SDK vers un format interne sûr (pas de message/headers/body).
 * Deny-by-default : tout ce qui n'est pas explicitement transitoire → UNKNOWN.
 */
export function mapAnthropicSdkError(error: unknown): AnthropicMappedError {
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
    return { kind: "AUTH", status: error.status }
  }
  if (error instanceof RateLimitError) {
    return { kind: "RATE_LIMIT", status: error.status }
  }
  if (error instanceof InternalServerError) {
    return { kind: "SERVER", status: error.status }
  }
  if (error instanceof APIConnectionTimeoutError) {
    return { kind: "TIMEOUT" }
  }
  if (error instanceof APIUserAbortError) {
    return { kind: "ABORT" }
  }
  if (error instanceof APIConnectionError) {
    return { kind: "NETWORK" }
  }
  // Duck-typing status uniquement pour sous-classes SDK non listées — pas pour Error générique.
  if (
    error &&
    typeof error === "object" &&
    "status" in error &&
    error.constructor &&
    error.constructor !== Error &&
    error.constructor !== Object
  ) {
    const status = Number((error as { status?: unknown }).status)
    if (status === 401 || status === 403) return { kind: "AUTH", status }
    if (status === 429) return { kind: "RATE_LIMIT", status }
    if (status >= 500 && status < 600) return { kind: "SERVER", status }
  }
  return { kind: "UNKNOWN" }
}

export function createAnthropicExtractionClient(apiKey: string): AnthropicExtractionClient {
  const client = new Anthropic({
    apiKey,
    // Les retries métier sont gérés par l'adapter (0–1). SDK = 0.
    maxRetries: 0,
  })
  return {
    messagesCreate: (body, options) =>
      client.messages.create(body, {
        timeout: options?.timeout,
        signal: options?.signal,
        maxRetries: options?.maxRetries ?? 0,
      }),
  }
}
