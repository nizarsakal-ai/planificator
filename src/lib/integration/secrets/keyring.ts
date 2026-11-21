/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-8A : trousseau des KEK (master keys) et environnement du coffre.
 *
 * SECURITY-SPEC §6 :
 * - une KEK ACTIVE par environnement pour les nouvelles écritures (`INTEGRATION_KEK_ACTIVE_ID`) ;
 * - plusieurs KEK LISIBLES pendant une rotation : chaque `INTEGRATION_KEK_<ID>` (base64, exactement 32 octets) ;
 * - emplacement : variables d'environnement serveur seulement (jamais navigateur, dépôt, base) ;
 * - distincte du matériel LEGACY_GMAIL (`GMAIL_TOKEN_ENCRYPTION_KEY`) ;
 * - fail-closed `SECURITY_CONFIGURATION_INVALID` si la configuration est absente ou incohérente.
 *
 * Aucune KEK n'est journalisée ni renvoyée : seul son `keyId` (non secret) circule.
 */
import { SecretProviderError } from "@/lib/integration/secrets/secret-errors"

type Env = Record<string, string | undefined>
export type SecretEnvironment = "production" | "preview" | "development" | "test"

export interface Keyring {
  readonly activeKeyId: string
  /** Clé par `keyId` ; ne jamais exposer hors du module de chiffrement. */
  key(keyId: string): Buffer
  has(keyId: string): boolean
  readonly keyIds: readonly string[]
}

const KEY_ID = /^[a-z0-9_]{1,32}$/
const PREFIX = "INTEGRATION_KEK_"
const ACTIVE_VAR = "INTEGRATION_KEK_ACTIVE_ID"

const invalid = (): never => { throw new SecretProviderError("SECURITY_CONFIGURATION_INVALID") }

function decodeKey(raw: string): Buffer {
  const trimmed = raw.trim()
  if (!/^[A-Za-z0-9+/]{43}=$/.test(trimmed)) invalid()
  const key = Buffer.from(trimmed, "base64")
  if (key.length !== 32) invalid()
  // Clé dégénérée (tous les octets identiques) : refusée, signe d'une valeur de remplissage.
  if (key.every((b) => b === key[0])) invalid()
  return key
}

/** Lit le trousseau depuis l'environnement ; lève SECURITY_CONFIGURATION_INVALID au moindre écart. */
export function loadKeyring(env: Env = process.env): Keyring {
  const activeKeyId = (env[ACTIVE_VAR] ?? "").trim()
  if (!KEY_ID.test(activeKeyId)) invalid()
  const legacy = (env.GMAIL_TOKEN_ENCRYPTION_KEY ?? "").trim()
  const keys = new Map<string, Buffer>()
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(PREFIX) || name === ACTIVE_VAR || value === undefined) continue
    const keyId = name.slice(PREFIX.length).toLowerCase()
    if (!KEY_ID.test(keyId)) invalid()
    if (legacy && value.trim() === legacy) invalid()
    keys.set(keyId, decodeKey(value))
  }
  if (!keys.has(activeKeyId)) invalid()
  // Deux keyId différents ne doivent jamais porter la même clé.
  const distinct = new Set([...keys.values()].map((k) => k.toString("hex")))
  if (distinct.size !== keys.size) invalid()
  return Object.freeze({
    activeKeyId,
    keyIds: Object.freeze([...keys.keys()].sort()),
    has: (keyId: string) => keys.has(keyId),
    key: (keyId: string) => keys.get(keyId) ?? invalid(),
  })
}

/** Environnement du coffre, lié à l'AAD (§5.3, §16) : un ciphertext d'un environnement ne s'ouvre pas dans un autre. */
export function resolveSecretEnvironment(env: Env = process.env): SecretEnvironment {
  const vercel = env.VERCEL_ENV
  if (vercel === "production" || vercel === "preview" || vercel === "development") return vercel
  if (vercel !== undefined && vercel !== "") invalid()
  return env.NODE_ENV === "test" ? "test" : "development"
}
