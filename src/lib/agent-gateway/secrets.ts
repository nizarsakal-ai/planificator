/**
 * PLAN-AGENT-GATEWAY-001 — LOT-1A
 * Lecture et validation des secrets de la passerelle (SPEC §4.5).
 * Aucune valeur par défaut, aucune valeur journalisée. Non utilisé avant LOT-1B.
 *
 * Encodages admis (politique fermée, revue Codex 2026-10-21) :
 *  - hex : alphabet [0-9a-fA-F], longueur paire ;
 *  - base64 standard (RFC 4648 §4) : alphabet [A-Za-z0-9+/], padding « = » OBLIGATOIRE,
 *    longueur multiple de 4 ;
 *  - base64url (RFC 4648 §5) : alphabet [A-Za-z0-9_-], SANS padding, longueur ≢ 1 (mod 4).
 * Les alphabets ne se mélangent pas. Chaque forme est vérifiée par ré-encodage canonique :
 * une valeur dont le décodage puis le ré-encodage ne redonne pas l'entrée est rejetée
 * (padding incohérent, bits de fin non nuls, caractères ignorés par un décodeur tolérant).
 * Une chaîne purement alphanumérique est d'abord lue comme hex si elle n'est composée que de
 * chiffres hexadécimaux, sinon comme base64 standard si sa longueur est un multiple de 4,
 * sinon comme base64url.
 */

import { AGENT_GATEWAY_SECRET_NAMES } from "@/lib/integration/flags/platform-flag-names"

export type AgentGatewaySecretName =
  (typeof AGENT_GATEWAY_SECRET_NAMES)[keyof typeof AGENT_GATEWAY_SECRET_NAMES]

/** 32 octets minimum (256 bits), conformément à SPEC §4.5. */
export const AGENT_GATEWAY_SECRET_MIN_BYTES = 32

export type AgentGatewaySecretErrorReason = "missing" | "too_short" | "malformed"

export class AgentGatewaySecretError extends Error {
  readonly code = "AGENT_GATEWAY_SECRET_INVALID" as const
  constructor(
    readonly variable: AgentGatewaySecretName,
    readonly reason: AgentGatewaySecretErrorReason
  ) {
    // Le message nomme la variable et la raison, jamais la valeur.
    super(`Secret ${variable} ${reason === "missing" ? "absent" : reason === "too_short" ? "trop court" : "malformé"}`)
    this.name = "AgentGatewaySecretError"
  }
}

type SecretEnv = NodeJS.ProcessEnv | Record<string, string | undefined>

const HEX_RE = /^[0-9a-fA-F]+$/
const BASE64_STD_RE = /^[A-Za-z0-9+/]+={0,2}$/
const BASE64_URL_RE = /^[A-Za-z0-9_-]+$/

/**
 * Décode `value` selon la politique fermée ci-dessus.
 * Retourne `null` si la valeur n'est dans aucune des formes admises.
 */
function decodeSecretValue(value: string): Buffer | null {
  if (HEX_RE.test(value)) {
    if (value.length % 2 !== 0) return null
    return Buffer.from(value, "hex")
  }

  if (BASE64_STD_RE.test(value) && value.length % 4 === 0) {
    const bytes = Buffer.from(value, "base64")
    return bytes.toString("base64") === value ? bytes : null
  }

  // Une chaîne alphanumérique pure de longueur ≢ 0 (mod 4) n'est pas du base64 standard
  // (padding obligatoire) mais peut être du base64url sans padding : on continue.

  if (BASE64_URL_RE.test(value)) {
    if (value.length % 4 === 1) return null
    const bytes = Buffer.from(value, "base64url")
    return bytes.toString("base64url") === value ? bytes : null
  }

  return null
}

/**
 * Lit et valide un secret de la passerelle.
 * Retourne les octets du secret ; ne conserve aucune copie.
 */
export function readAgentGatewaySecret(
  variable: AgentGatewaySecretName,
  env: SecretEnv = process.env
): Buffer {
  const raw = env[variable]
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new AgentGatewaySecretError(variable, "missing")
  }

  const bytes = decodeSecretValue(raw.trim())
  if (bytes === null) {
    throw new AgentGatewaySecretError(variable, "malformed")
  }
  if (bytes.length < AGENT_GATEWAY_SECRET_MIN_BYTES) {
    throw new AgentGatewaySecretError(variable, "too_short")
  }
  return bytes
}

export function readDigestSecret(env: SecretEnv = process.env): Buffer {
  return readAgentGatewaySecret(AGENT_GATEWAY_SECRET_NAMES.DIGEST_SECRET, env)
}

export function readCursorSecret(env: SecretEnv = process.env): Buffer {
  return readAgentGatewaySecret(AGENT_GATEWAY_SECRET_NAMES.CURSOR_SECRET, env)
}
