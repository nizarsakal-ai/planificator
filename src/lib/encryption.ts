import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto"

const ALGORITHM = "aes-256-gcm"
const KEY_LEN   = 32
const IV_LEN    = 12
const TAG_LEN   = 16

function getKey(): Buffer {
  const secret = process.env.GMAIL_TOKEN_ENCRYPTION_KEY
  if (!secret) throw new Error("GMAIL_TOKEN_ENCRYPTION_KEY not set")
  return scryptSync(secret, "planificator-salt", KEY_LEN)
}

export function encrypt(plaintext: string): string {
  const key = getKey()
  const iv  = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  // Format: iv(12) + tag(16) + ciphertext — all hex
  return Buffer.concat([iv, tag, encrypted]).toString("hex")
}

export function decrypt(ciphertext: string): string {
  const key  = getKey()
  const buf  = Buffer.from(ciphertext, "hex")
  const iv   = buf.subarray(0, IV_LEN)
  const tag  = buf.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const data = buf.subarray(IV_LEN + TAG_LEN)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(data) + decipher.final("utf8")
}
