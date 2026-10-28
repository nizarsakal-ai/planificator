import { createHmac, timingSafeEqual } from "node:crypto"
import type { IntakeContext } from "./access.core"
const TTL = 24 * 60 * 60 * 1000
function signature(ctx: IntakeContext, fileId: string, expires: number, secret: string) {
  return createHmac("sha256", secret).update(JSON.stringify(["supplier-intake-file-v1", ctx.userId, ctx.companyId, fileId, expires])).digest("hex")
}
export function issueFileProof(ctx: IntakeContext, fileId: string, secret: string, now = Date.now()) {
  if (secret.length < 32) throw new Error("SUPPLIER_INTAKE_SIGNING_UNAVAILABLE")
  const expires = now + TTL
  return `${expires}.${signature(ctx, fileId, expires, secret)}`
}
export function verifyFileProof(ctx: IntakeContext, fileId: string, proof: unknown, secret: string, now = Date.now()) {
  if (secret.length < 32 || typeof proof !== "string" || !/^\d{13}\.[a-f0-9]{64}$/.test(proof)) return false
  const [expiry, mac] = proof.split("."); const expires = Number(expiry)
  if (expires <= now || expires > now + TTL) return false
  return timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(signature(ctx, fileId, expires, secret), "hex"))
}
