/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-8A : chiffrement d'enveloppe des secrets PLATFORM_ENCRYPTED (SECURITY-SPEC §5).
 *
 * - Une DEK aléatoire de 32 octets PAR VERSION ; le secret est chiffré en AES-256-GCM avec cette DEK et un nonce
 *   aléatoire de 12 octets (jamais réutilisé, jamais déterministe).
 * - La DEK est enveloppée (AES-256-GCM) par la KEK active ; seule la DEK enveloppée est stockée.
 * - AAD du secret = JSON canonique de { companyId, connectionId, credentialsRef, secretKind, environment, secretVersion },
 *   figé à la création : un seul champ différent ⇒ échec du déchiffrement (fail-closed).
 * - AAD de la DEK = identité de la version + keyId : une DEK enveloppée ne se déplace pas d'une version à une autre.
 * - Uniquement `node:crypto` ; aucune cryptographie maison. Les erreurs ne portent qu'un code (§21).
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { SecretProviderError } from "@/lib/integration/secrets/secret-errors"
import type { Keyring, SecretEnvironment } from "@/lib/integration/secrets/keyring"

export const ENC_VERSION = 1
const ALGO = "aes-256-gcm"
const NONCE = 12
const TAG = 16
const MAX_PLAINTEXT_BYTES = 8192

export type SecretKind = "API_KEY" | "OAUTH_REFRESH_TOKEN" | "CONNECTOR_OTHER"

export interface SecretAadFields {
  companyId: string
  connectionId: string
  credentialsRef: string
  secretKind: SecretKind
  environment: SecretEnvironment
  secretVersion: number
}

export interface SealedSecret {
  keyId: string
  encVersion: number
  wrappedDek: Buffer
  dekNonce: Buffer
  dekTag: Buffer
  ciphertext: Buffer
  nonce: Buffer
  tag: Buffer
}

/** JSON canonique (clés triées) des champs AAD : sérialisation stable, indépendante de l'ordre d'écriture. */
function canonical(o: Record<string, string | number>): string {
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${JSON.stringify(o[k])}`).join(",")}}`
}
export function secretAad(f: SecretAadFields): Buffer {
  if (!Number.isSafeInteger(f.secretVersion) || f.secretVersion < 1) throw new SecretProviderError("SECRET_VERSION_UNSUPPORTED")
  return Buffer.from(canonical({ companyId: f.companyId, connectionId: f.connectionId, credentialsRef: f.credentialsRef, secretKind: f.secretKind, environment: f.environment, secretVersion: f.secretVersion }), "utf8")
}
function dekAad(f: SecretAadFields, keyId: string): Buffer {
  return Buffer.from(canonical({ purpose: "dek", keyId, encVersion: ENC_VERSION, companyId: f.companyId, connectionId: f.connectionId, credentialsRef: f.credentialsRef, secretVersion: f.secretVersion }), "utf8")
}

function gcmSeal(key: Buffer, plaintext: Buffer, aad: Buffer) {
  const nonce = randomBytes(NONCE)
  const c = createCipheriv(ALGO, key, nonce, { authTagLength: TAG })
  c.setAAD(aad)
  const ciphertext = Buffer.concat([c.update(plaintext), c.final()])
  return { ciphertext, nonce, tag: c.getAuthTag() }
}
function gcmOpen(key: Buffer, ciphertext: Buffer, nonce: Buffer, tag: Buffer, aad: Buffer): Buffer {
  if (nonce.length !== NONCE || tag.length !== TAG) throw new SecretProviderError("SECRET_DECRYPTION_FAILED")
  try {
    const d = createDecipheriv(ALGO, key, nonce, { authTagLength: TAG })
    d.setAAD(aad)
    d.setAuthTag(tag)
    return Buffer.concat([d.update(ciphertext), d.final()])
  } catch {
    throw new SecretProviderError("SECRET_DECRYPTION_FAILED")
  }
}

/** Chiffre un secret : nouvelle DEK, secret chiffré par la DEK, DEK enveloppée par la KEK active. */
export function sealSecret(plaintext: string, f: SecretAadFields, keyring: Keyring): SealedSecret {
  const bytes = Buffer.from(plaintext, "utf8")
  if (bytes.length < 1 || bytes.length > MAX_PLAINTEXT_BYTES) throw new SecretProviderError("SECRET_NOT_CONFIGURED")
  const dek = randomBytes(32)
  try {
    const secret = gcmSeal(dek, bytes, secretAad(f))
    const keyId = keyring.activeKeyId
    const wrapped = gcmSeal(keyring.key(keyId), dek, dekAad(f, keyId))
    return { keyId, encVersion: ENC_VERSION, wrappedDek: wrapped.ciphertext, dekNonce: wrapped.nonce, dekTag: wrapped.tag, ciphertext: secret.ciphertext, nonce: secret.nonce, tag: secret.tag }
  } finally {
    dek.fill(0)
  }
}

/** Déchiffre un secret ; tout écart (KEK inconnue, AAD, tag, version) ⇒ code stable, jamais de détail. */
export function openSecret(sealed: SealedSecret, f: SecretAadFields, keyring: Keyring): string {
  if (sealed.encVersion !== ENC_VERSION) throw new SecretProviderError("SECRET_VERSION_UNSUPPORTED")
  if (!keyring.has(sealed.keyId)) throw new SecretProviderError("SECURITY_CONFIGURATION_INVALID")
  const dek = gcmOpen(keyring.key(sealed.keyId), sealed.wrappedDek, sealed.dekNonce, sealed.dekTag, dekAad(f, sealed.keyId))
  try {
    if (dek.length !== 32) throw new SecretProviderError("SECRET_DECRYPTION_FAILED")
    return gcmOpen(dek, sealed.ciphertext, sealed.nonce, sealed.tag, secretAad(f)).toString("utf8")
  } finally {
    dek.fill(0)
  }
}

/**
 * Rotation de KEK (§6.2) : réenveloppe la DEK avec la KEK active, SANS rechiffrer le secret. Le ciphertext du secret,
 * son nonce et son tag restent identiques ; seuls keyId, DEK enveloppée, nonce et tag de la DEK changent.
 */
export function rewrapDek(sealed: SealedSecret, f: SecretAadFields, keyring: Keyring): Pick<SealedSecret, "keyId" | "wrappedDek" | "dekNonce" | "dekTag"> {
  if (sealed.encVersion !== ENC_VERSION) throw new SecretProviderError("SECRET_VERSION_UNSUPPORTED")
  if (!keyring.has(sealed.keyId)) throw new SecretProviderError("SECURITY_CONFIGURATION_INVALID")
  const dek = gcmOpen(keyring.key(sealed.keyId), sealed.wrappedDek, sealed.dekNonce, sealed.dekTag, dekAad(f, sealed.keyId))
  try {
    const keyId = keyring.activeKeyId
    const w = gcmSeal(keyring.key(keyId), dek, dekAad(f, keyId))
    return { keyId, wrappedDek: w.ciphertext, dekNonce: w.nonce, dekTag: w.tag }
  } finally {
    dek.fill(0)
  }
}

/** Indice non secret affiché à l'administrateur : 4 derniers caractères, seulement si le secret est assez long. */
export function secretHint(plaintext: string): string | null {
  return plaintext.length >= 16 ? plaintext.slice(-4) : null
}
