/**
 * Lot G2 Planificator V2 : Document Studio — règles PURES de contenu, utilisables côté serveur ET dans le navigateur
 * (aucune dépendance à Prisma ni à `node:crypto` : l'éditeur visuel calcule son aperçu avec exactement ce code).
 * Les empreintes restent dans `studio.core.ts`, qui réexporte tout ce module.
 *
 * Modèle (gabarit) → versions. Une version est un BROUILLON modifiable, puis PUBLIÉE (figée, empreinte SHA-256 de son
 * contenu canonique), puis RETIRÉE quand une version suivante est publiée. Seule une version publiée sert à générer.
 *
 * Corps : texte brut structuré, ligne par ligne ; une ligne vide sépare les blocs.
 *   « # Titre »            intertitre                 « ## Titre »          sous-titre
 *   « - élément »          liste à puces              « 1. élément »        liste numérotée (le numéro saisi est conservé)
 *   « | a | b | »          ligne de tableau (la première ligne est l'en-tête ; 8 colonnes au plus)
 *   « [saut de page] »     saut de page               « **texte** »         gras (dans un paragraphe ou un élément de liste)
 * Les champs s'écrivent {{cle}}. La mise en forme est lue dans le MODÈLE, avant le remplacement des champs : une valeur
 * saisie n'est jamais réinterprétée (ni champ, ni gras, ni tableau).
 *
 * Champs déclarés : texte, texte long, date, montant, nombre entier, liste de choix, case à cocher ; aide et valeur par
 * défaut facultatives. Champs système (entreprise, document, client, chantier) toujours disponibles. À la publication :
 * tout champ cité est déclaré ou système, tout champ déclaré est cité. À la génération : champ inconnu refusé, champ
 * obligatoire manquant refusé (liste nommée), valeurs typées ; l'instantané rendu est figé et empreint : le PDF est
 * reconstruit depuis lui seul.
 *
 * Compatibilité : un champ sans option nouvelle garde exactement sa forme d'origine (clé, libellé, type, obligatoire), et
 * un corps sans syntaxe nouvelle produit exactement les mêmes blocs qu'avant : empreintes inchangées.
 */
import { parseAmountToCents } from "@/lib/accounting/engine/money"
import { formatDay, parseDay } from "@/lib/equipment/equipment.core"

export type FieldType = "TEXT" | "LONG_TEXT" | "DATE" | "AMOUNT" | "NUMBER" | "CHOICE" | "CHECKBOX"
export const FIELD_TYPES: readonly FieldType[] = ["TEXT", "LONG_TEXT", "DATE", "AMOUNT", "NUMBER", "CHOICE", "CHECKBOX"]
export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  TEXT: "Texte", LONG_TEXT: "Texte long", DATE: "Date", AMOUNT: "Montant (€)", NUMBER: "Nombre entier", CHOICE: "Liste de choix", CHECKBOX: "Case à cocher",
}
export interface FieldDef {
  key: string; label: string; type: FieldType; required: boolean
  /** Liste de choix seulement : 2 à 20 valeurs distinctes. */
  options?: string[]
  /** Texte d'aide affiché sous le champ à la génération. */
  help?: string
  /** Valeur proposée à la génération (même forme que la saisie ; « oui » ou « non » pour une case à cocher). */
  defaultValue?: string
}

export const SYSTEM_FIELDS = [
  "entreprise", "numero", "date_document", "client", "chantier",
  "entreprise_adresse", "entreprise_siret", "entreprise_telephone", "entreprise_email",
  "client_adresse", "client_siret", "client_email", "client_telephone",
  "chantier_adresse", "chantier_debut", "chantier_fin",
] as const
export type SystemField = (typeof SYSTEM_FIELDS)[number]
export const SYSTEM_FIELD_LABEL: Record<SystemField, string> = {
  entreprise: "Nom de l'entreprise", numero: "Numéro du document", date_document: "Date du document", client: "Nom du client", chantier: "Nom du chantier",
  entreprise_adresse: "Adresse de l'entreprise", entreprise_siret: "SIRET de l'entreprise", entreprise_telephone: "Téléphone de l'entreprise", entreprise_email: "E-mail de l'entreprise",
  client_adresse: "Adresse du client", client_siret: "SIRET du client", client_email: "E-mail du client", client_telephone: "Téléphone du client",
  chantier_adresse: "Adresse du chantier", chantier_debut: "Date de début du chantier", chantier_fin: "Date de fin du chantier",
}
const isSystem = (k: string) => (SYSTEM_FIELDS as readonly string[]).includes(k)
/** Les cinq champs système d'origine (lot G), interdits depuis toujours comme clés de champs déclarés. Les onze ajoutés par
 * G2 ne sont refusés qu'à l'ENREGISTREMENT d'une version : une version stockée avant G2 qui déclare un champ de ce nom reste
 * lisible, et son champ déclaré l'emporte alors sur le champ système (rendu inchangé). Revue Codex du 23/11/2026. */
const ORIGINAL_SYSTEM_FIELDS: readonly string[] = ["entreprise", "numero", "date_document", "client", "chantier"]
const isOriginalSystem = (k: string) => ORIGINAL_SYSTEM_FIELDS.includes(k)

export const CATEGORIES = ["CONTRACT", "CERTIFICATE", "LETTER", "REPORT", "OTHER"] as const
export type Category = (typeof CATEGORIES)[number]
export const CATEGORY_LABEL: Record<Category, string> = { CONTRACT: "Contrat", CERTIFICATE: "Attestation", LETTER: "Courrier", REPORT: "Compte rendu", OTHER: "Autre" }

export const MAX_FIELDS = 40
export const MAX_BODY = 20_000
export const MAX_TEXT = 500
export const MAX_LONG_TEXT = 4000
export const MAX_OPTIONS = 20
export const MAX_OPTION = 80
export const MAX_HELP = 200
export const MAX_TABLE_COLUMNS = 8
export const PAGE_BREAK = "[saut de page]"

export const STUDIO_ERRORS = {
  notFound: "Élément introuvable.",
  name: "Nom du modèle obligatoire (3 à 120 caractères).",
  category: "Catégorie invalide.",
  duplicateName: "Un modèle porte déjà ce nom.",
  title: "Titre du document obligatoire (3 à 200 caractères).",
  body: "Corps du document obligatoire (20 000 caractères au plus).",
  fields: "Champs invalides : clé en minuscules (lettres, chiffres, _), libellé de 2 à 80 caractères, type connu, 40 champs au plus, clés uniques et distinctes des champs système ; une liste de choix a 2 à 20 valeurs distinctes ; une valeur par défaut respecte le type du champ.",
  table: `Tableau trop large : ${MAX_TABLE_COLUMNS} colonnes au plus.`,
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
  reservedKeys: (keys: string[]) => `Clés réservées aux champs automatiques : ${keys.join(", ")}. Renommez ces champs.`,
  versionChanged: "Le modèle a été republié entre-temps : rechargez la page et vérifiez le formulaire avant de générer.",
  notIntact: "Empreinte du contenu non conforme : ce document ne peut pas être validé.",
  copyName: "Impossible de nommer la copie : renommez d'abord des copies existantes.",
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
const SPACES = /[\s   ]/g

export function validateTemplateIdentity(input: { name: string; category: string }): Plan<{ name: string; category: Category }> {
  const name = input.name.replace(CONTROL, " ").trim()
  if (name.length < 3 || name.length > 120) return ko(STUDIO_ERRORS.name)
  if (!(CATEGORIES as readonly string[]).includes(input.category)) return ko(STUDIO_ERRORS.category)
  return okv({ name, category: input.category as Category })
}

// ── Montants : mêmes règles que la facturation (`billing/money`), sans sa dépendance à Prisma (tests de parité). ────────
const MAX_CENTS = BigInt("9999999999")
/** Montant saisi en euros (« 1 234,56 », « 1234.5 ») → centimes. Refuse signe et plus de 2 décimales (lève sinon). */
export function euroInputToCents(input: string): bigint {
  const s = input.replace(SPACES, "").replace(",", ".")
  if (s === "") return BigInt(0)
  const cents = parseAmountToCents(s)
  if (cents > MAX_CENTS) throw new RangeError("montant trop grand")
  return cents
}
/** « 1 234,56 € » avec des espaces ordinaires (texte brut, sûr pour les polices standard des PDF). */
export function formatEuroText(cents: bigint): string {
  const neg = cents < BigInt(0)
  const abs = neg ? -cents : cents
  const units = (abs / BigInt(100)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")
  return `${neg ? "−" : ""}${units},${(abs % BigInt(100)).toString().padStart(2, "0")} €`
}
/** Centimes stockés → texte de saisie (« 1234,56 ») pour préremplir un formulaire. */
export const centsToInput = (cents: string): string => {
  const c = BigInt(cents)
  return `${c / BigInt(100)},${(c % BigInt(100)).toString().padStart(2, "0")}`
}

// ── Champs ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
type Stored = { ok: true; value: string | null } | { ok: false }
/** Valeur saisie → valeur stockée (null : vide). Texte nettoyé, date AAAA-MM-JJ, montant en centimes, entier, choix de la
 * liste, case « oui » ou « non » (jamais vide). */
function storeValue(f: FieldDef, raw: string | null | undefined): Stored {
  const v = (raw ?? "").replace(/\r\n?/g, "\n")
  const t = (f.type === "LONG_TEXT" ? v.replace(CONTROL_EXCEPT_NL, " ") : v.replace(CONTROL, " ")).trim()
  if (f.type === "CHECKBOX") {
    const l = t.toLowerCase()
    if (["oui", "on", "true", "1"].includes(l)) return { ok: true, value: "oui" }
    return ["", "non", "off", "false", "0"].includes(l) ? { ok: true, value: "non" } : { ok: false }
  }
  if (t === "") return { ok: true, value: null }
  if (f.type === "TEXT") return t.length > MAX_TEXT ? { ok: false } : { ok: true, value: t }
  if (f.type === "LONG_TEXT") return t.length > MAX_LONG_TEXT ? { ok: false } : { ok: true, value: t }
  if (f.type === "DATE") { const d = parseDay(t); return d ? { ok: true, value: formatDay(d) } : { ok: false } }
  if (f.type === "AMOUNT") {
    try { return { ok: true, value: euroInputToCents(t).toString() } } catch { return { ok: false } }
  }
  if (f.type === "CHOICE") return (f.options ?? []).includes(t) ? { ok: true, value: t } : { ok: false }
  const n = t.replace(SPACES, "")
  return /^-?\d{1,12}$/.test(n) ? { ok: true, value: String(Number(n)) } : { ok: false }
}

function readOptions(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_OPTIONS) return null
  const out: string[] = []
  for (const o of raw) {
    if (typeof o !== "string") return null
    const t = o.replace(CONTROL, " ").trim()
    if (t.length < 1 || t.length > MAX_OPTION || out.includes(t)) return null
    out.push(t)
  }
  return out
}

/** Lit la déclaration des champs (formulaire ou JSON stocké) ; toute forme inattendue est refusée. */
export function readFields(raw: unknown): FieldDef[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_FIELDS) return null
  const seen = new Set<string>()
  const out: FieldDef[] = []
  for (const f of raw) {
    if (!f || typeof f !== "object") return null
    const { key, label, type, required, options, help, defaultValue } = f as Record<string, unknown>
    if (typeof key !== "string" || !KEY.test(key) || seen.has(key) || isOriginalSystem(key)) return null
    if (typeof label !== "string") return null
    const l = label.replace(CONTROL, " ").trim()
    if (l.length < 2 || l.length > 80) return null
    if (typeof type !== "string" || !(FIELD_TYPES as readonly string[]).includes(type) || typeof required !== "boolean") return null
    const def: FieldDef = { key, label: l, type: type as FieldType, required }
    if (def.type === "CHOICE") {
      const o = readOptions(options)
      if (!o) return null
      def.options = o
    } else if (options !== undefined && options !== null && !(Array.isArray(options) && options.length === 0)) return null
    if (help !== undefined && help !== null) {
      if (typeof help !== "string") return null
      const h = help.replace(CONTROL, " ").trim()
      if (h.length > MAX_HELP) return null
      if (h) def.help = h
    }
    if (defaultValue !== undefined && defaultValue !== null) {
      if (typeof defaultValue !== "string" || defaultValue.length > MAX_LONG_TEXT) return null
      const d = defaultValue.replace(/\r\n?/g, "\n").replace(CONTROL_EXCEPT_NL, " ").trim()
      if (d) {
        if (!storeValue(def, d).ok) return null
        def.defaultValue = d
      }
    }
    seen.add(key)
    out.push(def)
  }
  return out
}

export const placeholdersOf = (text: string): string[] => [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]))]

// ── Corps : lecture en blocs ─────────────────────────────────────────────────────────────────────────────────────────────
export interface Run { text: string; bold?: true }
export interface ListItem { text: string; marker?: string; runs?: Run[] }
export type BlockKind = "heading" | "subheading" | "paragraph" | "list" | "table" | "pagebreak"
export const BLOCK_KINDS: readonly BlockKind[] = ["heading", "subheading", "paragraph", "list", "table", "pagebreak"]
/** Bloc rendu. `text` est toujours présent (texte brut du bloc, vide pour un saut de page) ; `runs` seulement s'il y a du
 * gras ; `items` (et `ordered`) pour une liste ; `rows` pour un tableau (première ligne : en-tête). */
export interface Block { kind: BlockKind; text: string; runs?: Run[]; ordered?: boolean; items?: ListItem[]; rows?: string[][] }

const BOLD = /\*\*([^*\n]+)\*\*/g
type Fill = (text: string) => string
function inline(src: string, fill: Fill): { text: string; runs?: Run[] } {
  if (!src.includes("**")) return { text: fill(src).trim() }
  const runs: Run[] = []
  let last = 0
  for (const m of src.matchAll(BOLD)) {
    const at = m.index ?? 0
    if (at > last) runs.push({ text: fill(src.slice(last, at)) })
    runs.push({ text: fill(m[1]), bold: true })
    last = at + m[0].length
  }
  if (last < src.length) runs.push({ text: fill(src.slice(last)) })
  if (runs.length) { runs[0].text = runs[0].text.trimStart(); runs[runs.length - 1].text = runs[runs.length - 1].text.trimEnd() }
  const kept = runs.filter((r) => r.text !== "")
  const text = kept.map((r) => r.text).join("")
  return kept.some((r) => r.bold) && text.trim() ? { text, runs: kept } : { text: text.trim() }
}

const RE_HEADING = /^#\s+/
const RE_SUBHEADING = /^##\s+/
const RE_BULLET = /^\s*[-•]\s+(.*)$/
const RE_NUMBERED = /^\s*(\d{1,3}[.)])\s+(.*)$/
const RE_ROW = /^\s*\|(.*)\|\s*$/
// Ligne de séparation d'un tableau : au moins un tiret. Une ligne de cellules vides (« | | | ») est une vraie ligne.
const RE_SEPARATOR = /^[\s:|]*-[\s:|-]*$/

/** Découpe le corps d'un modèle en blocs ; `fill` remplace les champs (appliqué APRÈS la lecture de la mise en forme). */
export function renderBlocks(body: string, fill: Fill): Block[] {
  const blocks: Block[] = []
  for (const chunk of body.split(/\n\s*\n/)) {
    let para: string[] = []
    let list: { ordered: boolean; items: ListItem[] } | null = null
    let table: string[][] | null = null
    const flushPara = () => {
      if (para.length) { const p = inline(para.join("\n"), fill); if (p.text) blocks.push({ kind: "paragraph", ...p }) }
      para = []
    }
    const flushList = () => {
      if (list && list.items.length) blocks.push({ kind: "list", text: list.items.map((i) => `${i.marker ?? "•"} ${i.text}`).join("\n"), ordered: list.ordered, items: list.items })
      list = null
    }
    const flushTable = () => {
      if (table && table.length) {
        const width = Math.max(...table.map((r) => r.length))
        const rows = table.map((r) => [...r, ...Array.from({ length: width - r.length }, () => "")])
        blocks.push({ kind: "table", text: rows.map((r) => r.join(" | ")).join("\n"), rows })
      }
      table = null
    }
    const flush = () => { flushPara(); flushList(); flushTable() }
    const item = (ordered: boolean, src: string, marker?: string) => {
      flushPara(); flushTable()
      if (list && list.ordered !== ordered) flushList()
      list ??= { ordered, items: [] }
      const p = inline(src, fill)
      if (p.text) list.items.push(marker ? { marker, ...p } : p)
    }
    for (const line of chunk.split("\n")) {
      let m: RegExpExecArray | null
      if (RE_SUBHEADING.test(line)) { flush(); const t = fill(line.replace(RE_SUBHEADING, "")).trim(); if (t) blocks.push({ kind: "subheading", text: t }) }
      else if (RE_HEADING.test(line)) { flush(); const t = fill(line.replace(RE_HEADING, "")).trim(); if (t) blocks.push({ kind: "heading", text: t }) }
      else if (line.trim().toLowerCase() === PAGE_BREAK) { flush(); blocks.push({ kind: "pagebreak", text: "" }) }
      else if ((m = RE_BULLET.exec(line))) item(false, m[1])
      else if ((m = RE_NUMBERED.exec(line))) item(true, m[2], m[1])
      else if ((m = RE_ROW.exec(line))) {
        flushPara(); flushList()
        if (!RE_SEPARATOR.test(m[1])) (table ??= []).push(m[1].split("|").map((c) => fill(c).trim()))
      }
      else { flushList(); flushTable(); para.push(line) }
    }
    flush()
  }
  return blocks
}

/** Plus grand nombre de colonnes d'un tableau du corps (0 : aucun tableau). */
export const widestTable = (body: string): number => Math.max(0, ...renderBlocks(body, (t) => t).filter((b) => b.kind === "table").map((b) => b.rows?.[0]?.length ?? 0))

export interface VersionContent { title: string; body: string; fields: FieldDef[]; requiresApproval: boolean }
/** Contenu d'une version : valide, et cohérent entre champs cités et champs déclarés. */
export function validateVersionContent(input: { title: string; body: string; fields: unknown; requiresApproval: boolean }): Plan<VersionContent> {
  const title = input.title.replace(CONTROL, " ").trim()
  if (title.length < 3 || title.length > 200) return ko(STUDIO_ERRORS.title)
  const body = input.body.replace(/\r\n?/g, "\n").replace(CONTROL_EXCEPT_NL, " ").trim()
  if (body.length < 1 || body.length > MAX_BODY) return ko(STUDIO_ERRORS.body)
  const fields = readFields(input.fields)
  if (!fields) return ko(STUDIO_ERRORS.fields)
  const reserved = fields.filter((f) => isSystem(f.key)).map((f) => f.key)
  if (reserved.length) return ko(STUDIO_ERRORS.reservedKeys(reserved))
  if (widestTable(body) > MAX_TABLE_COLUMNS) return ko(STUDIO_ERRORS.table)
  const cited = placeholdersOf(`${title}\n${body}`)
  const declared = new Set(fields.map((f) => f.key))
  const undeclared = cited.filter((k) => !declared.has(k) && !isSystem(k))
  if (undeclared.length) return ko(STUDIO_ERRORS.undeclared(undeclared))
  const unused = fields.filter((f) => !cited.includes(f.key)).map((f) => f.key)
  if (unused.length) return ko(STUDIO_ERRORS.unused(unused))
  return okv({ title, body, fields, requiresApproval: input.requiresApproval === true })
}

/** Valeur stockée : texte nettoyé, date AAAA-MM-JJ, montant en centimes (chaîne), nombre entier (chaîne), choix, oui/non. */
export type StoredValues = Record<string, string>
export function validateValues(fields: readonly FieldDef[], raw: Record<string, string | null | undefined>): Plan<StoredValues> {
  const known = new Set(fields.map((f) => f.key))
  const unknown = Object.keys(raw).filter((k) => !known.has(k))
  if (unknown.length) return ko(STUDIO_ERRORS.unknown(unknown))
  const out: StoredValues = {}
  const missing: string[] = []
  for (const f of fields) {
    const s = storeValue(f, raw[f.key])
    if (!s.ok) return ko(STUDIO_ERRORS.invalidValue(f.label))
    // Case à cocher obligatoire : elle doit être cochée.
    if (s.value === null || (f.type === "CHECKBOX" && f.required && s.value !== "oui")) { if (f.required) missing.push(f.label); if (s.value === null) continue }
    out[f.key] = s.value
  }
  if (missing.length) return ko(STUDIO_ERRORS.missing(missing))
  return okv(out)
}

/** Valeurs à proposer dans le formulaire de génération : valeur d'un document précédent si elle convient encore au champ
 * (même clé, valeur toujours valide), sinon valeur par défaut, sinon vide. */
export function initialInputValues(fields: readonly FieldDef[], previous?: Record<string, unknown> | null): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of fields) {
    const p = previous?.[f.key]
    let v = f.defaultValue ?? ""
    if (typeof p === "string" && p !== "") {
      const asInput = f.type === "AMOUNT" && /^\d{1,12}$/.test(p) ? centsToInput(p) : p
      if (storeValue(f, asInput).ok) v = asInput
    }
    out[f.key] = v
  }
  return out
}

const dayFr = (iso: string) => new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`))
const intFr = (s: string) => Number(s).toLocaleString("fr-FR").replace(/[   ]/g, " ")

export interface SystemValues {
  entreprise: string; numero: string; date_document: string; client: string | null; chantier: string | null
  entreprise_adresse?: string | null; entreprise_siret?: string | null; entreprise_telephone?: string | null; entreprise_email?: string | null
  client_adresse?: string | null; client_siret?: string | null; client_email?: string | null; client_telephone?: string | null
  /** Dates du chantier : AAAA-MM-JJ. */
  chantier_adresse?: string | null; chantier_debut?: string | null; chantier_fin?: string | null
}
/** Coordonnées de l'émetteur figées dans l'instantané (pied de page du PDF) ; seules les données présentes y figurent. */
export interface Issuer { address?: string; siret?: string; phone?: string; email?: string }
export interface DocumentSnapshot {
  number: string; title: string; issuedOn: string; company: string
  template: { name: string; version: number; versionSha256: string }
  links: { client: string | null; worksite: string | null }
  issuer?: Issuer
  /** Logo de l'émetteur (data URL PNG gérée) FIGÉ à la génération : le PDF ne relit jamais le logo courant de la société. */
  logo?: string
  blocks: Block[]
}

/** Valeur affichée d'un champ (texte brut). */
export function displayValue(f: FieldDef | undefined, v: string | undefined): string {
  if (v === undefined) return ""
  if (!f) return v
  if (f.type === "DATE") return dayFr(v)
  if (f.type === "AMOUNT") return formatEuroText(BigInt(v))
  if (f.type === "NUMBER") return intFr(v)
  if (f.type === "CHECKBOX") return v === "oui" ? "Oui" : "Non"
  return v
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
/** Texte de chaque champ système (dates en clair, absent ⇒ vide). */
export function systemTexts(sys: SystemValues): Record<SystemField, string> {
  const day = (v: string | null | undefined) => (v && DAY.test(v) ? dayFr(v) : "")
  const s = (v: string | null | undefined) => (v ?? "").trim()
  return {
    entreprise: sys.entreprise, numero: sys.numero, date_document: dayFr(sys.date_document), client: sys.client ?? "", chantier: sys.chantier ?? "",
    entreprise_adresse: s(sys.entreprise_adresse), entreprise_siret: s(sys.entreprise_siret), entreprise_telephone: s(sys.entreprise_telephone), entreprise_email: s(sys.entreprise_email),
    client_adresse: s(sys.client_adresse), client_siret: s(sys.client_siret), client_email: s(sys.client_email), client_telephone: s(sys.client_telephone),
    chantier_adresse: s(sys.chantier_adresse), chantier_debut: day(sys.chantier_debut), chantier_fin: day(sys.chantier_fin),
  }
}

/** Remplacement textuel des champs, en un seul passage. `unknown` : texte d'un champ ni déclaré ni système (aperçu). */
export function filler(fields: readonly FieldDef[], values: StoredValues, sys: SystemValues, unknown: (key: string) => string = () => ""): Fill {
  const byKey = new Map(fields.map((f) => [f.key, f]))
  const sysMap = systemTexts(sys)
  return (text) => text.replace(PLACEHOLDER, (_, k: string) => (byKey.has(k) ? displayValue(byKey.get(k), values[k]) : isSystem(k) ? sysMap[k as SystemField] : unknown(k)))
}

/** Rendu déterministe : remplacement textuel des champs, découpage en blocs. */
export function renderDocument(content: VersionContent, values: StoredValues, sys: SystemValues, meta: { templateName: string; version: number; versionSha256: string; logo?: string | null }): DocumentSnapshot {
  const fill = filler(content.fields, values, sys)
  const issuer: Issuer = {}
  const put = (k: keyof Issuer, v: string | null | undefined) => { const t = (v ?? "").trim(); if (t) issuer[k] = t }
  put("address", sys.entreprise_adresse); put("siret", sys.entreprise_siret); put("phone", sys.entreprise_telephone); put("email", sys.entreprise_email)
  return {
    number: sys.numero, title: fill(content.title).trim() || meta.templateName, issuedOn: sys.date_document, company: sys.entreprise,
    template: { name: meta.templateName, version: meta.version, versionSha256: meta.versionSha256 },
    links: { client: sys.client, worksite: sys.chantier },
    ...(Object.keys(issuer).length ? { issuer } : {}),
    ...(meta.logo && isSnapshotLogo(meta.logo) ? { logo: meta.logo } : {}),
    blocks: renderBlocks(content.body, fill),
  }
}

/** Logo admissible dans un instantané : data URL PNG en base64 CANONIQUE (longueur multiple de 4, deux « = » au plus), qui
 * commence par la signature PNG, bornée à 600 Kio d'image (819 200 caractères de base64) : la forme produite par le réglage
 * du logo de la société. Contrôle de forme sans décodage, utilisable dans le navigateur. */
const SNAPSHOT_LOGO_PREFIX = "data:image/png;base64,"
const SNAPSHOT_LOGO_MAX_B64 = (600 * 1024 * 4) / 3
const PNG_SIGNATURE_B64 = "iVBORw0KGgo"
// Base64 canonique : groupes de quatre caractères ; avant « == » ou « = », le dernier caractère ne porte aucun bit
// inutilisé (sinon deux écritures différentes désigneraient les mêmes octets).
const RE_BASE64_CANONICAL = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/
export const isSnapshotLogo = (v: unknown): v is string => {
  if (typeof v !== "string" || !v.startsWith(SNAPSHOT_LOGO_PREFIX)) return false
  const b64 = v.slice(SNAPSHOT_LOGO_PREFIX.length)
  return b64.length <= SNAPSHOT_LOGO_MAX_B64 && b64.startsWith(PNG_SIGNATURE_B64) && RE_BASE64_CANONICAL.test(b64)
}

const isRuns = (r: unknown): boolean => Array.isArray(r) && r.every((x) => x && typeof x === "object" && typeof (x as Run).text === "string" && ((x as Run).bold === undefined || (x as Run).bold === true))
function isBlock(b: unknown): boolean {
  if (!b || typeof b !== "object") return false
  const k = b as Block
  if (!(BLOCK_KINDS as readonly string[]).includes(k.kind) || typeof k.text !== "string") return false
  if (k.runs !== undefined && !isRuns(k.runs)) return false
  if (k.ordered !== undefined && typeof k.ordered !== "boolean") return false
  if (k.items !== undefined && !(Array.isArray(k.items) && k.items.every((i) => i && typeof i.text === "string" && (i.marker === undefined || typeof i.marker === "string") && (i.runs === undefined || isRuns(i.runs))))) return false
  if (k.rows !== undefined && !(Array.isArray(k.rows) && k.rows.every((r) => Array.isArray(r) && r.every((c) => typeof c === "string")))) return false
  if (k.kind === "list" && !k.items) return false
  if (k.kind === "table" && !k.rows) return false
  return true
}

/** Lecture prudente d'un instantané stocké. */
export function readSnapshot(raw: unknown): DocumentSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const s = raw as DocumentSnapshot
  if (typeof s.number !== "string" || typeof s.title !== "string" || typeof s.issuedOn !== "string" || typeof s.company !== "string") return null
  if (!s.template || typeof s.template.name !== "string" || !Number.isSafeInteger(s.template.version) || typeof s.template.versionSha256 !== "string") return null
  if (!s.links || !Array.isArray(s.blocks) || !s.blocks.every(isBlock)) return null
  if (s.issuer !== undefined && (!s.issuer || typeof s.issuer !== "object" || Array.isArray(s.issuer) || !Object.values(s.issuer).every((v) => typeof v === "string"))) return null
  if (s.logo !== undefined && !isSnapshotLogo(s.logo)) return null
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

/** Champs déclarés en texte : une ligne par champ « cle | libellé | TYPE | obligatoire|facultatif », avec une cinquième
 * partie « choix 1 ; choix 2 » pour une liste de choix. (Format d'origine, conservé ; l'éditeur visuel envoie du JSON.) */
export function parseFieldLines(text: string): FieldDef[] | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean)
  const rows = lines.map((l) => l.split("|").map((p) => p.trim()))
  if (rows.some((r) => (r.length !== 4 && r.length !== 5) || !["obligatoire", "facultatif"].includes(r[3].toLowerCase()))) return null
  return readFields(rows.map(([key, label, type, req, options]) => ({ key, label, type: type.toUpperCase(), required: req.toLowerCase() === "obligatoire", ...(options !== undefined ? { options: options.split(";").map((o) => o.trim()).filter(Boolean) } : {}) })))
}
export const fieldLines = (fields: readonly FieldDef[]) => fields.map((f) => `${f.key} | ${f.label} | ${f.type} | ${f.required ? "obligatoire" : "facultatif"}${f.options ? ` | ${f.options.join(" ; ")}` : ""}`).join("\n")

/** Champs envoyés par l'éditeur visuel (JSON) ; `null` si la forme est invalide. */
export function parseFieldsJson(text: string): FieldDef[] | null {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return null }
  return readFields(raw)
}

/** Clé proposée à partir d'un libellé : minuscules sans accents, « _ » entre les mots, 40 caractères au plus. */
export function keyFromLabel(label: string): string {
  const k = label.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+/, "").replace(/_+$/, "").slice(0, 40).replace(/_+$/, "")
  return k
}

// ── Aperçu (éditeur) : valeurs d'exemple, sans rien enregistrer ──────────────────────────────────────────────────────────
/** Valeurs d'exemple au format stocké : valeur par défaut si elle est valide, sinon un exemple selon le type. */
export function sampleValues(fields: readonly FieldDef[], today: string): StoredValues {
  const out: StoredValues = {}
  for (const f of fields) {
    const d = f.defaultValue ? storeValue(f, f.defaultValue) : null
    if (d && d.ok && d.value !== null) { out[f.key] = d.value; continue }
    out[f.key] = f.type === "DATE" ? today : f.type === "AMOUNT" ? "123456" : f.type === "NUMBER" ? "12" : f.type === "CHOICE" ? (f.options?.[0] ?? "") : f.type === "CHECKBOX" ? "oui" : `[${f.label || f.key}]`
  }
  return out
}
export function sampleSystem(company: string, today: string): SystemValues {
  return {
    entreprise: company, numero: "DOC-0000-0000", date_document: today, client: "[Client]", chantier: "[Chantier]",
    entreprise_adresse: "[Adresse de l'entreprise]", entreprise_siret: "[SIRET de l'entreprise]", entreprise_telephone: "[Téléphone]", entreprise_email: "[E-mail]",
    client_adresse: "[Adresse du client]", client_siret: "[SIRET du client]", client_email: "[E-mail du client]", client_telephone: "[Téléphone du client]",
    chantier_adresse: "[Adresse du chantier]", chantier_debut: today, chantier_fin: today,
  }
}

/** Nom d'une copie de modèle : « Nom (copie) », puis « (copie 2) »… ; tronqué pour tenir en 120 caractères ; `null` si les
 * 50 premiers noms sont pris. */
export function copyName(name: string, taken: ReadonlySet<string>): string | null {
  for (let i = 1; i <= 50; i++) {
    const suffix = i === 1 ? " (copie)" : ` (copie ${i})`
    const candidate = `${name.slice(0, 120 - suffix.length).trimEnd()}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  return null
}
