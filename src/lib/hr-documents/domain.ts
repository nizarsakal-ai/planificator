import { createHash } from "node:crypto"
import { z } from "zod"
import { isAcceptedCategory } from "./catalog"

export const MAX_PDF_BYTES = 10 * 1024 * 1024
export const CAPABILITIES = ["IMPORT", "PUBLISH", "READ", "CONFIGURE"] as const
export type Capability = typeof CAPABILITIES[number]
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)
export const employeeSelectionSchema = id.optional()
// PLV2-DOC-RH-002 : catégorie lue dans le catalogue (codes historiques seuls tant que le drapeau est absent).
export const reviewSchema = z.object({ employeeId: id, category: z.string().regex(/^[A-Z_]{2,40}$/).refine(c=>isAcceptedCategory(c)),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), title: z.string().trim().min(1).max(120),
  key: z.string().uuid(), expectedVersion: z.number().int().min(1).max(2147483647).optional(),
}).strict()
const isoDate = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/)
/** PLV2-DOC-RH-002 — fiche à compléter : uniquement des champs relus et validés par l'opérateur. */
export const draftSchema = z.object({ firstName: z.string().trim().min(1).max(80), lastName: z.string().trim().min(1).max(80),
  birthDate: isoDate.optional(), sex: z.enum(["M", "F"]).optional(), nationality: z.string().regex(/^[A-Z]{3}$/).optional(),
  identityExpiry: isoDate.optional(), documentNumberEnd: z.string().regex(/^[A-Z0-9]{1,4}$/).optional(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), key: z.string().uuid() }).strict()
export type DraftInput = z.infer<typeof draftSchema>
export function recognitionEnabled(env: NodeJS.ProcessEnv = process.env) { return env.HR_DOCUMENT_RECOGNITION_ENABLED === "true" }
export function employeeDraftsEnabled(env: NodeJS.ProcessEnv = process.env) { return env.HR_DOCUMENT_EMPLOYEE_DRAFTS_ENABLED === "true" }
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
export type StorageNotReadyReason = "stockage_absent" | "variable_comptes_invalide" | "entree_entreprise_absente" | "connexion_drive_non_active" | "compte_drive_different" | "generation_differente" | "url_notification_invalide"
export class HrError extends Error {
  /** `reason` : motif technique fixe (jamais une valeur), journalisé seulement pour STORAGE_NOT_READY, jamais renvoyé au client. */
  constructor(readonly code: string, readonly status = 400, readonly reason?: StorageNotReadyReason) { super(code) }
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
export type DocumentKind = "pdf" | "jpeg" | "png" | "heic"
export const KIND_MIME: Record<DocumentKind,string> = { pdf: "application/pdf", jpeg: "image/jpeg", png: "image/png", heic: "image/heic" }
export const KIND_EXTENSION: Record<DocumentKind,string> = { pdf: "pdf", jpeg: "jpg", png: "png", heic: "heic" }
export function imagesEnabled(env: NodeJS.ProcessEnv = process.env) { return env.HR_DOCUMENT_IMAGES_ENABLED === "true" }
const HEIC_BRANDS = ["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"]
/** Type réel lu dans les octets (signature + fin de fichier), jamais dans le nom ou le type déclaré. */
export function detectKind(bytes: Uint8Array): DocumentKind | null {
  const head = Buffer.from(bytes.subarray(0, 16)), tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 1024)))
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return tail.toString("latin1").includes("%%EOF") ? "pdf" : null
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return tail.includes(Buffer.from([0xff, 0xd9])) ? "jpeg" : null
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return tail.includes(Buffer.from("IEND", "latin1")) ? "png" : null
  if (head.subarray(4, 8).toString("latin1") === "ftyp" && HEIC_BRANDS.includes(head.subarray(8, 12).toString("latin1"))) return "heic"
  return null
}
/** PDF toujours ; JPG, PNG et HEIC seulement si HR_DOCUMENT_IMAGES_ENABLED=true. */
export function validateDocument(bytes: Uint8Array, allowImages = imagesEnabled()): { hash: string; kind: DocumentKind } {
  if (!allowImages) return { hash: validatePdf(bytes), kind: "pdf" }
  const kind = bytes.length && bytes.length <= MAX_PDF_BYTES ? detectKind(bytes) : null
  if (!kind) throw new HrError("INVALID_FILE")
  return { hash: digest(bytes), kind }
}
export function assertContent(bytes: Uint8Array, expectedHash: string, expectedSize: number) {
  // Intégrité d'un document déjà stocké : son type a été contrôlé au dépôt (une image reste lisible si le drapeau est coupé).
  if (bytes.length !== expectedSize || validateDocument(bytes, true).hash !== expectedHash) throw new HrError("CONTENT_CHANGED", 409)
}
export const messages: Record<string,string> = {
  FORBIDDEN: "Accès non autorisé.", NOT_FOUND: "Document indisponible.", DISABLED: "Fonction non disponible.",
  CONFLICT: "La version a changé. Rechargez et vérifiez le document.", CONTENT_CHANGED: "Le fichier a changé. Une nouvelle vérification RH est nécessaire.",
  INVALID_PDF: "PDF invalide ou supérieur à 10 Mo.", INVALID_INPUT: "Vérifiez les champs du formulaire.",
  INVALID_FILE: "Fichier invalide : PDF, JPG, PNG ou HEIC de 10 Mo au maximum.",
  DRIVE_PRIVATE_REQUIRED: "Le dossier Drive doit être privé et appartenir au compte configuré.",
  DRIVE_UNAVAILABLE: "Drive est indisponible. Réessayez avec la même opération.", STORAGE_NOT_READY: "Le stockage RH n’est pas encore configuré.",
  DUPLICATE: "Un document identique existe déjà pour ce salarié et cette période.",
  RECEIPT_CONFLICT: "Cette opération a déjà été utilisée avec un autre contenu.",
  DRAFT_EMPLOYEE: "Fiche à compléter : la publication sera possible une fois le salarié activé.",
}
