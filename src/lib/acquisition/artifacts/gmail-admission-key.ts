import { createHash } from "node:crypto"

export function gmailAdmissionKey(externalMessageId: string): string {
  const digest = createHash("sha256").update(externalMessageId).digest("hex")
  return `consultations-gmail-v1:${digest}`
}
