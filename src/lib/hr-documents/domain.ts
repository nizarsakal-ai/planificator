import { createHash } from "node:crypto"
import { z } from "zod"

export const MAX_PDF_BYTES = 10 * 1024 * 1024
export const CAPABILITIES = ["IMPORT", "PUBLISH", "READ", "CONFIGURE"] as const
export type Capability = typeof CAPABILITIES[number]
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)
export const employeeSelectionSchema = id.optional()
export const reviewSchema = z.object({ employeeId: id, category: z.enum(["PAYSLIP", "CONTRACT", "AMENDMENT", "OTHER"]),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), title: z.string().trim().min(1).max(120),
  key: z.string().uuid(), expectedVersion: z.number().int().min(1).max(2147483647).optional(),
}).strict()
export const publicationSchema = z.object({ expectedVersion: z.number().int().positive().max(2147483647), key: z.string().uuid() }).strict()
export type ReviewInput = z.infer<typeof reviewSchema>
export type Identity = { userId: string; companyId: string }
export type Actor = Identity & { employeeId: string | null; capabilities: Capability[] }
const grantSchema = z.array(z.object({ userId: id, companyId: id, capabilities: z.array(z.enum(CAPABILITIES)).max(4) }).strict()).max(1000)
export function capabilitiesFor(raw: string | undefined, identity: Identity): Capability[] {
  if (!raw || raw.length > 100_000) return []
  try {
    const parsed = grantSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) return []
    return [...new Set(parsed.data.filter(g => g.userId === identity.userId && g.companyId === identity.companyId).flatMap(g => g.capabilities))]
  } catch { return [] }
}
export class HrError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code) }
}
export function requireCapability(actor: Actor, capability: Capability) {
  if (!actor.capabilities.includes(capability)) throw new HrError("FORBIDDEN", 403)
}
export function canRead(actor: Actor, doc: {companyId: string; employeeId: string; status: string}): boolean {
  return doc.companyId === actor.companyId && (actor.capabilities.includes("READ") ||
    (doc.status === "PUBLISHED" && actor.employeeId === doc.employeeId))
}
export function digest(bytes: Uint8Array | string) { return createHash("sha256").update(bytes).digest("hex") }
export function validatePdf(bytes: Uint8Array): string {
  if (!bytes.length || bytes.length > MAX_PDF_BYTES || Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-" ||
    !Buffer.from(bytes.subarray(Math.max(0, bytes.length - 1024))).toString().includes("%%EOF")) throw new HrError("INVALID_PDF")
  // Documents are always downloaded as attachments in a sandbox, never executed inline.
  return digest(bytes)
}
export function assertContent(bytes: Uint8Array, expectedHash: string, expectedSize: number) {
  if (bytes.length !== expectedSize || validatePdf(bytes) !== expectedHash) throw new HrError("CONTENT_CHANGED", 409)
}
export const messages: Record<string,string> = {
  FORBIDDEN: "Accès non autorisé.", NOT_FOUND: "Document indisponible.", DISABLED: "Fonction non disponible.",
  CONFLICT: "La version a changé. Rechargez et vérifiez le document.", CONTENT_CHANGED: "Le fichier a changé. Une nouvelle vérification RH est nécessaire.",
  INVALID_PDF: "PDF invalide ou supérieur à 10 Mo.", INVALID_INPUT: "Vérifiez les champs du formulaire.",
  DRIVE_PRIVATE_REQUIRED: "Le dossier Drive doit être privé et appartenir au compte configuré.",
  DRIVE_UNAVAILABLE: "Drive est indisponible. Réessayez avec la même opération.", STORAGE_NOT_READY: "Le stockage RH n’est pas encore configuré.",
  DUPLICATE: "Un document identique existe déjà pour ce salarié et cette période.",
  RECEIPT_CONFLICT: "Cette opération a déjà été utilisée avec un autre contenu.",
}
