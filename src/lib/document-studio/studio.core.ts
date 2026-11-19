/**
 * Lot G Planificator V2 : Document Studio — règles PURES.
 *
 * Modèle (gabarit) → versions. Une version est un BROUILLON modifiable, puis PUBLIÉE (figée, empreinte SHA-256 de son
 * contenu canonique), puis RETIRÉE quand une version suivante est publiée. Seule une version publiée sert à générer.
 * Corps : texte brut ; une ligne « # Titre » est un intertitre, les paragraphes sont séparés par une ligne vide ; les
 * champs s'écrivent {{cle}}. Champs déclarés (texte, texte long, date, montant, nombre) et champs système (entreprise,
 * numéro, date du document, client, chantier). À la publication : tout champ cité est déclaré ou système, tout champ
 * déclaré est cité. À la génération : champ inconnu refusé, champ obligatoire manquant refusé (liste nommée), valeurs
 * typées ; le rendu remplace les champs par du TEXTE (aucune interprétation), puis l'instantané est figé et empreint :
 * le PDF est reconstruit depuis lui seul.
 * Portage sur ef36578f (19/11/2026) : forme canonique et empreinte locales au lot G (`./canonical`, sémantique v6 inchangée),
 * sans dépendance au lot D.
 */
import { canonicalJson, sha256Hex } from "@/lib/document-studio/canonical"
import { formatEuro, parseEuroInputToCents } from "@/lib/billing/money"
import { formatDay, parseDay } from "@/lib/equipment/equipment.core"

export type FieldType = "TEXT" | "LONG_TEXT" | "DATE" | "AMOUNT" | "NUMBER"
export const FIELD_TYPES: readonly FieldType[] = ["TEXT", "LONG_TEXT", "DATE", "AMOUNT", "NUMBER"]
export const FIELD_TYPE_LABEL: Record<FieldType, string> = { TEXT: "Texte", LONG_TEXT: "Texte long", DATE: "Date", AMOUNT: "Montant (€)", NUMBER: "Nombre entier" }
export interface FieldDef { key: string; label: string; type: FieldType; required: boolean }
export const SYSTEM_FIELDS = ["entreprise", "numero", "date_document", "client", "chantier"] as const
export type SystemField = (typeof SYSTEM_FIELDS)[number]
export const CATEGORIES = ["CONTRACT", "CERTIFICATE", "LETTER", "REPORT", "OTHER"] as const
export type Category = (typeof CATEGORIES)[number]
export const CATEGORY_LABEL: Record<Category, string> = { CONTRACT: "Contrat", CERTIFICATE: "Attestation", LETTER: "Courrier", REPORT: "Compte rendu", OTHER: "Autre" }

export const MAX_FIELDS = 40
export const MAX_BODY = 20_000
export const MAX_TEXT = 500
export const MAX_LONG_TEXT = 4000

export const STUDIO_ERRORS = {
  notFound: "Élément introuvable.",
  name: "Nom du modèle obligatoire (3 à 120 caractères).",
  category: "Catégorie invalide.",
  duplicateName: "Un modèle porte déjà ce nom.",
  title: "Titre du document obligatoire (3 à 200 caractères).",
  body: "Corps du document obligatoire (20 000 caractères au plus).",
  fields: "Champs invalides : clé en minuscules (lettres, chiffres, _), libellé de 2 à 80 caractères, type connu, 40 champs au plus, clés uniques et distinctes des champs système.",
  undeclared: (keys: string[]) => `Champs cités mais non déclarés : ${keys.join(", ")}.`,
  unused: (keys: string[]) => `Champs déclarés mais jamais cités : ${keys.join(", ")}.`,
  notDraft: "Seul un brouillon peut être modifié ou publié.",
  draftExists: "Un brouillon existe déjà pour ce modèle.",
  noPublished: "Ce modèle n'a aucune version publiée.",
  missing: (labels: string[]) => `Champs obligatoires manquants : ${labels.join(", ")}.`,
  // Écho borné (revue indépendante) : au plus 5 clés de 40 caractères dans le message renvoyé.
  unknown: (keys: string[]) => `Champs inconnus : ${keys.slice(0, 5).map((k) => k.slice(0, 40)).join(", ")}${keys.length > 5 ? "…" : ""}.`,
  invalidValue: (label: string) => `Valeur invalide pour « ${label} ».`,
  notPending: "Ce document n'est pas en attente de validation.",
  selfApproval: "La validation ou le refus revient à un autre administrateur que l'auteur du document.",
  signerName: "Nom du signataire obligatoire (2 à 120 caractères).",
  reason: "Motif de refus obligatoire (3 à 500 caractères).",
  changedMeanwhile: "Modifié entre-temps : rechargez la page.",
} as const

export type Plan<T> = { ok: true; value: T } | { ok: false; error: string }
const ko = (error: string): { ok: false; error: string } => ({ ok: false, error })
const okv = <T>(value: T): Plan<T> => ({ ok: true, value })
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_NL = /[\u0000-\u0009\u000b-\u001f\u007f]/g
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g
const KEY = /^[a-z][a-z0-9_]{0,39}$/
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]{0,39})\s*\}\}/g

export function validateTemplateIdentity(input: { name: string; category: string }): Plan<{ name: string; category: Category }> {
  const name = input.name.replace(CONTROL, " ").trim()
  if (name.length < 3 || name.length > 120) return ko(STUDIO_ERRORS.name)
  if (!(CATEGORIES as readonly string[]).includes(input.category)) return ko(STUDIO_ERRORS.category)
  return okv({ name, category: input.category as Category })
}

/** Lit la déclaration des champs (formulaire ou JSON stocké) ; toute forme inattendue est refusée. */
export function readFields(raw: unknown): FieldDef[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_FIELDS) return null
  const seen = new Set<string>()
  const out: FieldDef[] = []
  for (const f of raw) {
    if (!f || typeof f !== "object") return null
    const { key, label, type, required } = f as Record<string, unknown>
    if (typeof key !== "string" || !KEY.test(key) || seen.has(key) || (SYSTEM_FIELDS as readonly string[]).includes(key)) return null
    if (typeof label !== "string") return null
    const l = label.replace(CONTROL, " ").trim()
    if (l.length < 2 || l.length > 80) return null
    if (typeof type !== "string" || !(FIELD_TYPES as readonly string[]).includes(type) || typeof required !== "boolean") return null
    seen.add(key)
    out.push({ key, label: l, type: type as FieldType, required })
  }
  return out
}

export const placeholdersOf = (text: string): string[] => [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]))]

export interface VersionContent { title: string; body: string; fields: FieldDef[]; requiresApproval: boolean }
/** Contenu d'une version : valide, et cohérent entre champs cités et champs déclarés. */
export function validateVersionContent(input: { title: string; body: string; fields: unknown; requiresApproval: boolean }): Plan<VersionContent> {
  const title = input.title.replace(CONTROL, " ").trim()
  if (title.length < 3 || title.length > 200) return ko(STUDIO_ERRORS.title)
  const body = input.body.replace(/\r\n?/g, "\n").replace(CONTROL_EXCEPT_NL, " ").trim()
  if (body.length < 1 || body.length > MAX_BODY) return ko(STUDIO_ERRORS.body)
  const fields = readFields(input.fields)
  if (!fields) return ko(STUDIO_ERRORS.fields)
  const cited = placeholdersOf(`${title}\n${body}`)
  const declared = new Set(fields.map((f) => f.key))
  const undeclared = cited.filter((k) => !declared.has(k) && !(SYSTEM_FIELDS as readonly string[]).includes(k))
  if (undeclared.length) return ko(STUDIO_ERRORS.undeclared(undeclared))
  const unused = fields.filter((f) => !cited.includes(f.key)).map((f) => f.key)
  if (unused.length) return ko(STUDIO_ERRORS.unused(unused))
  return okv({ title, body, fields, requiresApproval: input.requiresApproval === true })
}

/** Empreinte du contenu publié (ordre des champs conservé : il fixe l'ordre du formulaire). */
export const versionSha256 = (c: VersionContent) => sha256Hex(canonicalJson({ title: c.title, body: c.body, fields: c.fields.map((f) => ({ ...f })), requiresApproval: c.requiresApproval }))

/** Valeur stockée : texte nettoyé, date AAAA-MM-JJ, montant en centimes (chaîne), nombre entier (chaîne). */
export type StoredValues = Record<string, string>
export function validateValues(fields: readonly FieldDef[], raw: Record<string, string | null | undefined>): Plan<StoredValues> {
  const known = new Set(fields.map((f) => f.key))
  const unknown = Object.keys(raw).filter((k) => !known.has(k))
  if (unknown.length) return ko(STUDIO_ERRORS.unknown(unknown))
  const out: StoredValues = {}
  const missing: string[] = []
  for (const f of fields) {
    const v = (raw[f.key] ?? "").replace(/\r\n?/g, "\n")
    const t = (f.type === "LONG_TEXT" ? v.replace(CONTROL_EXCEPT_NL, " ") : v.replace(CONTROL, " ")).trim()
    if (t === "") { if (f.required) missing.push(f.label); continue }
    if (f.type === "TEXT") { if (t.length > MAX_TEXT) return ko(STUDIO_ERRORS.invalidValue(f.label)); out[f.key] = t }
    else if (f.type === "LONG_TEXT") { if (t.length > MAX_LONG_TEXT) return ko(STUDIO_ERRORS.invalidValue(f.label)); out[f.key] = t }
    else if (f.type === "DATE") { const d = parseDay(t); if (!d) return ko(STUDIO_ERRORS.invalidValue(f.label)); out[f.key] = formatDay(d) }
    else if (f.type === "AMOUNT") {
      let c: bigint
      try { c = parseEuroInputToCents(t) } catch { return ko(STUDIO_ERRORS.invalidValue(f.label)) }
      out[f.key] = c.toString()
    } else {
      if (!/^-?\d{1,12}$/.test(t.replace(/[\s\u00a0\u202f]/g, ""))) return ko(STUDIO_ERRORS.invalidValue(f.label))
      out[f.key] = String(Number(t.replace(/[\s\u00a0\u202f]/g, "")))
    }
  }
  if (missing.length) return ko(STUDIO_ERRORS.missing(missing))
  return okv(out)
}

const dayFr = (iso: string) => new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`))
const intFr = (s: string) => Number(s).toLocaleString("fr-FR").replace(/[  ]/g, " ")

export interface SystemValues { entreprise: string; numero: string; date_document: string; client: string | null; chantier: string | null }
export interface Block { kind: "heading" | "paragraph"; text: string }
export interface DocumentSnapshot {
  number: string; title: string; issuedOn: string; company: string
  template: { name: string; version: number; versionSha256: string }
  links: { client: string | null; worksite: string | null }
  blocks: Block[]
}

/** Valeur affichée d'un champ (texte brut). */
export function displayValue(f: FieldDef | undefined, v: string | undefined): string {
  if (v === undefined) return ""
  if (!f) return v
  if (f.type === "DATE") return dayFr(v)
  if (f.type === "AMOUNT") return formatEuro(BigInt(v)).replace(/[  ]/g, " ")
  if (f.type === "NUMBER") return intFr(v)
  return v
}

/** Rendu déterministe : remplacement textuel des champs, découpage en intertitres et paragraphes. */
export function renderDocument(content: VersionContent, values: StoredValues, sys: SystemValues, meta: { templateName: string; version: number; versionSha256: string }): DocumentSnapshot {
  const byKey = new Map(content.fields.map((f) => [f.key, f]))
  const sysMap: Record<SystemField, string> = { entreprise: sys.entreprise, numero: sys.numero, date_document: dayFr(sys.date_document), client: sys.client ?? "", chantier: sys.chantier ?? "" }
  const fill = (text: string) => text.replace(PLACEHOLDER, (_, k: string) => ((SYSTEM_FIELDS as readonly string[]).includes(k) ? sysMap[k as SystemField] : displayValue(byKey.get(k), values[k])))
  const blocks: Block[] = []
  for (const chunk of content.body.split(/\n\s*\n/)) {
    const lines = chunk.split("\n")
    let para: string[] = []
    const flush = () => { const t = fill(para.join("\n")).trim(); if (t) blocks.push({ kind: "paragraph", text: t }); para = [] }
    for (const line of lines) {
      if (/^#\s+/.test(line)) { flush(); const t = fill(line.replace(/^#\s+/, "")).trim(); if (t) blocks.push({ kind: "heading", text: t }) }
      else para.push(line)
    }
    flush()
  }
  return {
    number: sys.numero, title: fill(content.title).trim() || meta.templateName, issuedOn: sys.date_document, company: sys.entreprise,
    template: { name: meta.templateName, version: meta.version, versionSha256: meta.versionSha256 },
    links: { client: sys.client, worksite: sys.chantier },
    blocks,
  }
}
export const documentSha256 = (s: DocumentSnapshot) => sha256Hex(canonicalJson(s))

/** Lecture prudente d'un instantané stocké. */
export function readSnapshot(raw: unknown): DocumentSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const s = raw as DocumentSnapshot
  if (typeof s.number !== "string" || typeof s.title !== "string" || typeof s.issuedOn !== "string" || typeof s.company !== "string") return null
  if (!s.template || typeof s.template.name !== "string" || !Number.isSafeInteger(s.template.version) || typeof s.template.versionSha256 !== "string") return null
  if (!s.links || !Array.isArray(s.blocks) || !s.blocks.every((b) => b && (b.kind === "heading" || b.kind === "paragraph") && typeof b.text === "string")) return null
  return s
}

export function validateSignerName(raw: string | null | undefined): Plan<string> {
  const n = (raw ?? "").replace(CONTROL, " ").trim()
  return n.length < 2 || n.length > 120 ? ko(STUDIO_ERRORS.signerName) : okv(n)
}
export function validateReason(raw: string | null | undefined): Plan<string> {
  const n = (raw ?? "").replace(CONTROL, " ").trim()
  return n.length < 3 || n.length > 500 ? ko(STUDIO_ERRORS.reason) : okv(n)
}

/** Champs déclarés depuis le formulaire : une ligne par champ « cle | libellé | TYPE | obligatoire|facultatif ». */
export function parseFieldLines(text: string): FieldDef[] | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean)
  const rows = lines.map((l) => l.split("|").map((p) => p.trim()))
  if (rows.some((r) => r.length !== 4 || !["obligatoire", "facultatif"].includes(r[3].toLowerCase()))) return null
  return readFields(rows.map(([key, label, type, req]) => ({ key, label, type: type.toUpperCase(), required: req.toLowerCase() === "obligatoire" })))
}
export const fieldLines = (fields: readonly FieldDef[]) => fields.map((f) => `${f.key} | ${f.label} | ${f.type} | ${f.required ? "obligatoire" : "facultatif"}`).join("\n")
