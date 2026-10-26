// Jeton de signature publique : 256 bits aléatoires (base64url, 43 caractères), seul le sha256 est stocké.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { quoteValidityEnd } from "./quote-validity"

export const SIGNATURE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
export const DEFAULT_SIGNATURE_VALIDITY_DAYS = 30

export function generateSignatureToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url")
  return { token, hash: hashSignatureToken(token) }
}

export function hashSignatureToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex")
}

/**
 * Empreinte d'adresse IP : HMAC-SHA256 avec un secret serveur (un sha256 nu serait réversible par force brute sur
 * l'espace IPv4). Sans secret, aucune empreinte n'est stockée (null).
 */
export function hashIp(ip: string | null | undefined, secret: string | undefined = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET): string | null {
  if (!ip || !secret) return null
  return createHmac("sha256", secret).update(`ip|${ip.trim()}`, "utf8").digest("hex")
}

export function isValidSignatureToken(token: unknown): token is string {
  return typeof token === "string" && SIGNATURE_TOKEN_PATTERN.test(token)
}

/**
 * Expiration technique du jeton (correctif P2-04) : fin de validité métier du devis (dernier instant du jour `validUntil`
 * en Europe/Paris) si elle est définie, sinon +30 jours. Un devis dont la validité est dépassée n'obtient JAMAIS de jeton :
 * l'appelant doit refuser l'envoi/renvoi avant (isQuoteValidAt) ; cette fonction ne prolonge plus silencieusement l'autorité.
 */
export function signatureExpiry(validUntil: Date | null, now: Date): Date {
  if (!validUntil) return new Date(now.getTime() + DEFAULT_SIGNATURE_VALIDITY_DAYS * 86_400_000)
  const end = quoteValidityEnd(validUntil)
  if (end.getTime() <= now.getTime()) throw new Error("QUOTE_EXPIRED: aucun jeton ne peut être émis pour un devis dont la validité est dépassée")
  return end
}

export function safeEqualHash(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8"), bb = Buffer.from(b, "utf8")
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}
