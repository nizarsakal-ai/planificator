/**
 * Lot D Planificator V2 : réserves de réception et procès-verbal — règles PURES (sans base, testables).
 *
 * - Une réserve est ouverte (OPEN), puis levée (LIFTED, avec note et preuve facultative) ou annulée (CANCELLED, avec
 *   motif, seulement si elle n'est inscrite à aucun procès-verbal). Elle n'est jamais supprimée.
 * - Les preuves (photo JPEG, PNG, WebP ou PDF, 5 Mo au plus) sont contrôlées par leur SIGNATURE binaire, jamais par
 *   l'extension ou le type déclaré par le navigateur.
 * - Un procès-verbal fige, à la signature, TOUTES les réserves ouvertes du chantier et la décision. « Sans réserves »
 *   n'est possible que si aucune réserve n'est ouverte ; « avec réserves » exige au moins une réserve ouverte ; un refus
 *   de réception liste aussi les réserves ouvertes. L'instantané est sérialisé de façon CANONIQUE (clés triées) et son
 *   SHA-256 est stocké : le PDF est régénéré depuis cet instantané seul, donc à l'identique.
 */
import { createHash } from "node:crypto"
import { inflateSync } from "node:zlib"

export type ReserveSeverity = "MINOR" | "MAJOR" | "BLOCKING"
export type ReserveStatus = "OPEN" | "LIFTED" | "CANCELLED"
export type ReceptionDecision = "WITHOUT_RESERVES" | "WITH_RESERVES" | "REFUSED"
export const SEVERITIES: readonly ReserveSeverity[] = ["MINOR", "MAJOR", "BLOCKING"]
export const DECISIONS: readonly ReceptionDecision[] = ["WITHOUT_RESERVES", "WITH_RESERVES", "REFUSED"]
export const SEVERITY_LABEL: Record<ReserveSeverity, string> = { MINOR: "Mineure", MAJOR: "Majeure", BLOCKING: "Bloquante" }
export const STATUS_LABEL: Record<ReserveStatus, string> = { OPEN: "Ouverte", LIFTED: "Levée", CANCELLED: "Annulée" }
export const DECISION_LABEL: Record<ReceptionDecision, string> = {
  WITHOUT_RESERVES: "Réception prononcée sans réserves",
  WITH_RESERVES: "Réception prononcée avec réserves",
  REFUSED: "Réception refusée",
}

export const MAX_FILE_BYTES = 5_000_000
export const MAX_FILES_PER_ACTION = 5
export const SIGNATURE_MIN_BYTES = 100
export const SIGNATURE_MAX_BYTES = 300_000
export const SNAPSHOT_VERSION = "pv-v1"
/** Listes AFFICHÉES : plafonnées (troncature signalée à l'écran). Ne s'applique jamais à l'instantané d'un procès-verbal. */
export const MAX_LISTED_RESERVES = 500
/** Un procès-verbal inscrit TOUTES les réserves ouvertes, au plus 500 : au-delà, la signature est REFUSÉE, jamais tronquée
 * (même borne contrôlée en base par le déclencheur différé). */
export const MAX_REPORT_RESERVES = 500
export const MAX_ASSIGNEE_LABEL = 120

export const RESERVE_ERRORS = {
  notFound: "Élément introuvable.",
  title: "Intitulé obligatoire (3 à 200 caractères).",
  location: "Localisation obligatoire (200 caractères au plus).",
  description: "Description trop longue (4 000 caractères au plus).",
  severity: "Gravité invalide.",
  note: "Note de levée obligatoire (3 à 2 000 caractères).",
  reason: "Motif d'annulation obligatoire (3 à 500 caractères).",
  notOpen: "Cette réserve n'est plus ouverte.",
  listedInReport: "Cette réserve figure à un procès-verbal signé : elle se lève, elle ne s'annule pas.",
  file: "Fichier refusé : photo JPEG, PNG ou WebP, ou PDF, de 5 Mo au plus.",
  tooManyFiles: `Au plus ${MAX_FILES_PER_ACTION} fichiers par envoi.`,
  decision: "Décision de réception invalide.",
  withoutReservesButOpen: "Des réserves sont ouvertes : la réception ne peut pas être prononcée sans réserves (levez-les ou annulez-les d'abord).",
  withReservesButNone: "Aucune réserve ouverte : une réception « avec réserves » est impossible.",
  signer: "Noms des signataires obligatoires (2 à 120 caractères).",
  attendees: "Liste des présents trop longue (1 000 caractères au plus).",
  remarks: "Observations trop longues (4 000 caractères au plus).",
  signature: "Signature du client absente ou invalide.",
  receptionDate: "Date de réception invalide (ni future, ni antérieure au chantier de plus de 10 ans).",
  dueDate: "Échéance invalide.",
  assignee: `Responsable trop long (${MAX_ASSIGNEE_LABEL} caractères au plus).`,
  tooManyReserves: `Plus de ${MAX_REPORT_RESERVES} réserves ouvertes : un procès-verbal en inscrit ${MAX_REPORT_RESERVES} au plus. Levez ou annulez des réserves avant de signer (aucune réserve n'est omise).`,
  changedMeanwhile: "Les réserves du chantier ont changé pendant la signature : rechargez la page.",
} as const

export type Plan<T> = { ok: true; value: T } | { ok: false; error: string }
const ko = (error: string): { ok: false; error: string } => ({ ok: false, error })
const okv = <T>(value: T): Plan<T> => ({ ok: true, value })
const clean = (v: string | null | undefined) => (v ?? "").trim()

// ── Réserves ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Le responsable est un LIBELLÉ LIBRE (aucun lien vers les salariés : module RH non touché, aucune identité validée). */
export interface ReserveInput { title: string; location: string; description?: string | null; severity: string; dueDate?: Date | null; assigneeLabel?: string | null }
export function validateReserve(input: ReserveInput): Plan<{ title: string; location: string; description: string | null; severity: ReserveSeverity; dueDate: Date | null; assigneeLabel: string | null }> {
  const title = clean(input.title), location = clean(input.location), description = clean(input.description) || null
  const assigneeLabel = clean(input.assigneeLabel) || null
  if (assigneeLabel && assigneeLabel.length > MAX_ASSIGNEE_LABEL) return ko(RESERVE_ERRORS.assignee)
  if (title.length < 3 || title.length > 200) return ko(RESERVE_ERRORS.title)
  if (location.length < 1 || location.length > 200) return ko(RESERVE_ERRORS.location)
  if (description && description.length > 4000) return ko(RESERVE_ERRORS.description)
  if (!(SEVERITIES as readonly string[]).includes(input.severity)) return ko(RESERVE_ERRORS.severity)
  if (input.dueDate && Number.isNaN(input.dueDate.getTime())) return ko(RESERVE_ERRORS.dueDate)
  return okv({ title, location, description, severity: input.severity as ReserveSeverity, dueDate: input.dueDate ?? null, assigneeLabel })
}

export function planLift(status: ReserveStatus, note: string | null | undefined): Plan<{ note: string }> {
  if (status !== "OPEN") return ko(RESERVE_ERRORS.notOpen)
  const n = clean(note)
  if (n.length < 3 || n.length > 2000) return ko(RESERVE_ERRORS.note)
  return okv({ note: n })
}

export function planCancel(status: ReserveStatus, listedInReport: boolean, reason: string | null | undefined): Plan<{ reason: string }> {
  if (status !== "OPEN") return ko(RESERVE_ERRORS.notOpen)
  if (listedInReport) return ko(RESERVE_ERRORS.listedInReport)
  const r = clean(reason)
  if (r.length < 3 || r.length > 500) return ko(RESERVE_ERRORS.reason)
  return okv({ reason: r })
}

// ── Fichiers de preuve ───────────────────────────────────────────────────────────────────────────────────────────

/** Type réel d'après la signature binaire ; null si le contenu n'est pas une image ou un PDF admis. */
export function sniffMime(bytes: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | "application/pdf" | null {
  const b = bytes
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg"
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return "image/png"
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "image/webp"
  if (b.length >= 5 && String.fromCharCode(...b.slice(0, 5)) === "%PDF-") return "application/pdf"
  return null
}

export const sha256Hex = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")

/** Nom de fichier affichable : sans chemin ni caractère de contrôle, 200 caractères au plus. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ""
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, "").trim().slice(0, 200)
  return cleaned || "preuve"
}

export function planFile(name: string, bytes: Uint8Array): Plan<{ mime: string; size: number; sha256: string; originalName: string }> {
  if (bytes.length < 1 || bytes.length > MAX_FILE_BYTES) return ko(RESERVE_ERRORS.file)
  const mime = sniffMime(bytes)
  if (!mime) return ko(RESERVE_ERRORS.file)
  return okv({ mime, size: bytes.length, sha256: sha256Hex(bytes), originalName: safeFileName(name) })
}

// ── Signature : PNG structurellement valide ─────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
})()
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
export const SIGNATURE_MAX_SIDE = 4000
/** Taille décompressée maximale admise (bornée AVANT décompression) : 16 Mo, bien au-delà d'un canevas de signature. */
export const SIGNATURE_MAX_RAW_BYTES = 16_000_000
/** Profil admis = celui d'un canevas de navigateur : RVB (2) ou RVBA (6), 8 bits, non entrelacé. */
const CHANNELS: Record<number, number> = { 2: 3, 6: 4 }
/** Seuls blocs CRITIQUES admis (1re lettre majuscule) ; tout autre bloc critique (PLTE compris) est refusé. Les blocs
 * auxiliaires (sRGB, pHYs, tEXt…) sont ignorés après contrôle de leur CRC. */
const CRITICAL_ALLOWED = new Set(["IHDR", "IDAT", "IEND"])

/**
 * PNG STRUCTURELLEMENT valide (revue préliminaire D : l'en-tête seul ne prouve pas le décodage), PROFIL CANEVAS seulement :
 * RVB ou RVBA 8 bits, non entrelacé (format de `canvas.toDataURL("image/png")`). Contrôles : signature, IHDR en premier
 * (dimensions 1 à 4 000 et taille décompressée ≤ 16 Mo, bornées AVANT décompression), aucun bloc critique autre que
 * IHDR, IDAT et IEND (palette, bloc critique inconnu : refus), blocs bornés et CRC exacts, au moins un IDAT contigu, IEND final sans octet après ; données IDAT décompressées
 * (zlib) à la taille EXACTE attendue, octet de filtre de chaque ligne valide (0 à 4). Les valeurs de pixels ne sont pas
 * interprétées (le rendu PDF les décode) : ce contrôle refuse un fichier tronqué, forgé ou incohérent.
 */
export function isStructurallyValidPng(png: Uint8Array): boolean {
  const b = Buffer.from(png.buffer, png.byteOffset, png.byteLength)
  if (b.length < 8 + 25 + 12 + 12 || sniffMime(b) !== "image/png") return false
  let off = 8, width = 0, height = 0, colorType = -1, depth = 0, seenIdat = false, idatClosed = false, ended = false
  const idat: Buffer[] = []
  while (off + 12 <= b.length) {
    const len = b.readUInt32BE(off)
    if (len > 0x7fffffff || off + 12 + len > b.length) return false
    const type = b.toString("latin1", off + 4, off + 8)
    const body = b.subarray(off + 8, off + 8 + len)
    if (crc32(b.subarray(off + 4, off + 8 + len)) !== b.readUInt32BE(off + 8 + len)) return false
    if (off === 8) {
      if (type !== "IHDR" || len !== 13) return false
      width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]; colorType = body[9]
      if (width < 1 || height < 1 || width > SIGNATURE_MAX_SIDE || height > SIGNATURE_MAX_SIDE) return false
      if (!(colorType in CHANNELS) || depth !== 8 || body[10] !== 0 || body[11] !== 0 || body[12] !== 0) return false
    } else if (type === "IHDR") return false
    else if (!/^[A-Za-z]{4}$/.test(type) || (type.charCodeAt(0) < 97 && !CRITICAL_ALLOWED.has(type))) return false
    else if (type === "IDAT") { if (idatClosed) return false; seenIdat = true; idat.push(body) }
    else if (seenIdat) idatClosed = true
    off += 12 + len
    if (type === "IEND") { ended = len === 0; break }
  }
  if (!ended || off !== b.length || !seenIdat) return false
  const rowBytes = Math.ceil((width * CHANNELS[colorType] * depth) / 8)
  const expected = height * (1 + rowBytes)
  if (expected > SIGNATURE_MAX_RAW_BYTES) return false // borne AVANT toute décompression (bombe zlib)
  let raw: Buffer
  try { raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 }) } catch { return false }
  if (raw.length !== expected) return false
  for (let y = 0; y < height; y++) if (raw[y * (1 + rowBytes)] > 4) return false
  return true
}

/** Signature dessinée : URL de données PNG (base64) → octets PNG vérifiés (taille bornée, structure PNG complète). */
export function parseSignature(dataUrl: string | null | undefined): Plan<{ png: Buffer; sha256: string }> {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(clean(dataUrl))
  if (!m) return ko(RESERVE_ERRORS.signature)
  const png = Buffer.from(m[1], "base64")
  if (png.length < SIGNATURE_MIN_BYTES || png.length > SIGNATURE_MAX_BYTES || !isStructurallyValidPng(png)) return ko(RESERVE_ERRORS.signature)
  return okv({ png, sha256: sha256Hex(png) })
}

// ── Procès-verbal ────────────────────────────────────────────────────────────────────────────────────────────────

export interface ReportInput {
  decision: string; receptionDate: Date | null; clientSignerName: string; companySignerName: string
  attendees?: string | null; remarks?: string | null
}
/** Valide le formulaire du procès-verbal au regard des réserves OUVERTES du chantier. */
export function planReport(input: ReportInput, openReserveCount: number, today: Date): Plan<{
  decision: ReceptionDecision; receptionDate: Date; clientSignerName: string; companySignerName: string; attendees: string | null; remarks: string | null
}> {
  if (!(DECISIONS as readonly string[]).includes(input.decision)) return ko(RESERVE_ERRORS.decision)
  const decision = input.decision as ReceptionDecision
  if (openReserveCount > MAX_REPORT_RESERVES) return ko(RESERVE_ERRORS.tooManyReserves)
  if (decision === "WITHOUT_RESERVES" && openReserveCount > 0) return ko(RESERVE_ERRORS.withoutReservesButOpen)
  if (decision === "WITH_RESERVES" && openReserveCount === 0) return ko(RESERVE_ERRORS.withReservesButNone)
  const d = input.receptionDate
  const tenYears = 10 * 366 * 86_400_000
  if (!d || Number.isNaN(d.getTime()) || d.getTime() > today.getTime() || d.getTime() < today.getTime() - tenYears) return ko(RESERVE_ERRORS.receptionDate)
  const client = clean(input.clientSignerName), company = clean(input.companySignerName)
  if (client.length < 2 || client.length > 120 || company.length < 2 || company.length > 120) return ko(RESERVE_ERRORS.signer)
  const attendees = clean(input.attendees) || null, remarks = clean(input.remarks) || null
  if (attendees && attendees.length > 1000) return ko(RESERVE_ERRORS.attendees)
  if (remarks && remarks.length > 4000) return ko(RESERVE_ERRORS.remarks)
  return okv({ decision, receptionDate: d, clientSignerName: client, companySignerName: company, attendees, remarks })
}

/** `assignee` : libellé libre du responsable saisi sur la réserve (format d'instantané pv-v1 inchangé). */
export interface SnapshotReserve { number: string; title: string; location: string; severity: ReserveSeverity; description: string | null; dueDate: string | null; assignee: string | null }
export interface ReportSnapshot {
  version: typeof SNAPSHOT_VERSION
  number: string
  company: { name: string }
  worksite: { name: string; address: string | null; client: string }
  decision: ReceptionDecision
  receptionDate: string
  signedAt: string
  clientSignerName: string
  companySignerName: string
  attendees: string | null
  remarks: string | null
  reserves: SnapshotReserve[]
  signatureSha256: string
}

/** Sérialisation canonique : clés triées à tous les niveaux, aucun espace ; seule source de l'empreinte. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    // jsonb normalise les décimaux (1.10 → 1.1) : seuls les entiers sûrs gardent une empreinte recalculable à l'identique.
    if (typeof value === "number" && !Number.isSafeInteger(value)) throw new RangeError("nombre non entier dans l'instantané")
    if (value === undefined) throw new TypeError("valeur indéfinie")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const o = value as Record<string, unknown>
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`
}
export const snapshotSha256 = (s: ReportSnapshot) => sha256Hex(canonicalJson(s))

/** Réserves triées par numéro : l'ordre du procès-verbal ne dépend pas de l'ordre de lecture en base. */
export function sortReserves(rs: readonly SnapshotReserve[]): SnapshotReserve[] {
  return [...rs].sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0))
}

/** Numéro « PRÉFIXE-AAAA-NNNN » (compteur par entreprise, type et année). */
export const documentNumber = (prefix: "RES" | "PV", year: number, value: number) => `${prefix}-${year}-${String(value).padStart(4, "0")}`
