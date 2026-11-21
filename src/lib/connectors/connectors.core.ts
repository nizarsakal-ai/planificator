/**
 * Lot F Planificator V2 : centre de connecteurs — règles PURES (curseurs, validation des éléments reçus, codes
 * d'erreur stables).
 *
 * - Curseur (watermark) : un curseur opaque par ressource, sérialisé en JSON canonique ; avancé uniquement par une
 *   synchronisation réussie (dans la même transaction que les enregistrements reçus).
 * - Idempotence : un élément est identifié par (connecteur, ressource, identifiant externe) ; son contenu canonique a
 *   une empreinte SHA-256. Même empreinte ⇒ inchangé (aucune écriture) ; empreinte différente ⇒ nouvelle version.
 * - Erreurs : seul un CODE stable de liste fermée est conservé et affiché, jamais le message d'origine (qui pourrait
 *   contenir une donnée externe ou un secret).
 */
import { canonicalJson, sha256Hex } from "@/lib/connectors/canonical"
import type { ConnectorDefinition } from "@/lib/connectors/catalog"

export const PAGE_SIZE = 50
export const MAX_PAGES_PER_RESOURCE = 20
// Revue indépendante : marge sous la borne de la base (8 192 octets de la forme texte jsonb, plus large que la forme
// canonique) pour qu'un élément accepté ici ne soit jamais refusé par la contrainte.
export const MAX_PAYLOAD_BYTES = 6000
export const MAX_FIELDS = 40

export const SYNC_ERROR_CODES = ["SOURCE_UNAVAILABLE", "SOURCE_ITEM_INVALID", "WATERMARK_INVALID", "REAL_CONNECTION_DISABLED", "INTERNAL_ERROR", "AUTH_FAILED", "RATE_LIMITED"] as const
export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[number]
export const SYNC_ERROR_LABEL: Record<SyncErrorCode, string> = {
  SOURCE_UNAVAILABLE: "Source indisponible : synchronisation annulée, rien n'a été enregistré.",
  SOURCE_ITEM_INVALID: "Élément reçu invalide : synchronisation annulée, rien n'a été enregistré.",
  WATERMARK_INVALID: "Curseur de synchronisation illisible : réinitialisez-le pour repartir du début.",
  REAL_CONNECTION_DISABLED: "Connexion réelle indisponible : activez-la et vérifiez les identifiants.",
  INTERNAL_ERROR: "Erreur interne : synchronisation annulée, rien n'a été enregistré.",
  // LOT-8B : erreurs d'une source réelle (codes stables ; le message du service n'est jamais repris).
  AUTH_FAILED: "Le service a refusé les identifiants : vérifiez-les ou enregistrez-en de nouveaux. Rien n'a été enregistré.",
  RATE_LIMITED: "Le service limite temporairement les appels : réessayez dans quelques minutes. Rien n'a été enregistré.",
}

export const CONNECTOR_ERRORS = {
  notFound: "Connecteur inconnu.",
  mode: "Mode invalide : seuls « désactivé », « simulation » et « connexion réelle » existent.",
  liveUnavailable: "Connexion réelle indisponible : enregistrez d'abord des identifiants valides pour ce service.",
  notLive: "Ce connecteur n'est pas en connexion réelle.",
  sameMode: "Le connecteur est déjà dans ce mode.",
  notSimulation: "Activez d'abord la simulation : le connecteur est désactivé.",
  changedMeanwhile: "Le connecteur a été modifié entre-temps : rechargez la page.",
  liveCooldown: "Une synchronisation réelle vient d'avoir lieu : patientez une minute avant la suivante.",
} as const

/** Erreur de source à code stable (le message est le code lui-même, jamais un texte externe). */
export class ConnectorSourceError extends Error {
  constructor(readonly code: SyncErrorCode) { super(code); this.name = "ConnectorSourceError" }
}
export const toErrorCode = (e: unknown): SyncErrorCode => (e instanceof ConnectorSourceError ? e.code : "INTERNAL_ERROR")

// LOT-8C : 1 000 caractères au plus (les jetons de page et de synchronisation de Google Agenda, encodés en base64url,
// dépassent parfois 200) ; même alphabet fermé, et la base borne toujours le curseur entier à 4 000 caractères.
const CURSOR = /^[A-Za-z0-9:_-]{1,1000}$/
export type Watermark = Record<string, string>

/** Lit un curseur stocké ; toute forme inattendue est refusée (jamais d'interprétation tolérante). */
export function parseWatermark(def: ConnectorDefinition, raw: string | null): Watermark {
  if (raw === null) return {}
  let v: unknown
  try { v = JSON.parse(raw) } catch { throw new ConnectorSourceError("WATERMARK_INVALID") }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new ConnectorSourceError("WATERMARK_INVALID")
  const allowed = new Set(def.resources.map((r) => r.key))
  const out: Watermark = {}
  for (const [k, c] of Object.entries(v as Record<string, unknown>)) {
    if (!allowed.has(k) || typeof c !== "string" || !CURSOR.test(c)) throw new ConnectorSourceError("WATERMARK_INVALID")
    out[k] = c
  }
  return out
}
export function serializeWatermark(w: Watermark): string | null {
  const keys = Object.keys(w)
  return keys.length === 0 ? null : canonicalJson(w)
}
export function isValidCursor(c: unknown): c is string {
  return typeof c === "string" && CURSOR.test(c)
}

export type SourceValue = string | number | boolean | null
export interface SourceItem { externalId: string; data: Record<string, SourceValue> }
const FIELD = /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/** Valide un élément reçu et calcule son empreinte canonique ; tout écart est refusé (code stable). */
export function checkItem(item: unknown): { externalId: string; data: Record<string, SourceValue>; hash: string } {
  const bad = (): never => { throw new ConnectorSourceError("SOURCE_ITEM_INVALID") }
  if (item === null || typeof item !== "object") bad()
  const { externalId, data } = item as { externalId?: unknown; data?: unknown }
  if (typeof externalId !== "string" || externalId.length < 1 || externalId.length > 200 || CONTROL.test(externalId)) bad()
  if (data === null || typeof data !== "object" || Array.isArray(data)) bad()
  const entries = Object.entries(data as Record<string, unknown>)
  if (entries.length > MAX_FIELDS) bad()
  const clean: Record<string, SourceValue> = {}
  for (const [k, v] of entries) {
    if (!FIELD.test(k)) bad()
    if (v === null || typeof v === "boolean") clean[k] = v as SourceValue
    else if (typeof v === "number") { if (!Number.isSafeInteger(v)) bad(); clean[k] = v }
    else if (typeof v === "string") { if (v.length > 500 || CONTROL.test(v)) bad(); clean[k] = v }
    else bad()
  }
  const json = canonicalJson(clean)
  if (Buffer.byteLength(json, "utf8") > MAX_PAYLOAD_BYTES) bad()
  return { externalId: externalId as string, data: clean, hash: sha256Hex(json) }
}

export type UpsertKind = "created" | "updated" | "unchanged"
/** Décision d'écriture pour un élément, d'après l'empreinte connue (ou absente). */
export function decideUpsert(knownHash: string | undefined, hash: string): UpsertKind {
  if (knownHash === undefined) return "created"
  return knownHash === hash ? "unchanged" : "updated"
}

export interface SyncCounts { received: number; created: number; updated: number; unchanged: number }
export const emptyCounts = (): SyncCounts => ({ received: 0, created: 0, updated: 0, unchanged: 0 })

/**
 * LOT-8B : connecteurs dotés d'une connexion RÉELLE en lecture seule (mode LIVE). Les autres restent en simulation.
 * La base porte la même liste (CHECK `connector_settings_live_check`). Le réseau et les identifiants ne vivent pas dans
 * ce module : voir `src/lib/integration/connectors/live/`.
 */
// LOT-8C : Google Agenda, par OAuth (refresh token dans le coffre, jeton d'accès en mémoire seulement).
export const LIVE_CONNECTOR_KEYS = ["shopify", "mailchimp", "slack", "google_calendar"] as const
/** Connexions réelles autorisées par OAuth (bouton « Se connecter avec Google ») plutôt que par saisie d'identifiants. */
export const OAUTH_LIVE_KEYS = ["google_calendar"] as const
export const isOAuthLiveKey = (k: string): k is (typeof OAUTH_LIVE_KEYS)[number] => (OAUTH_LIVE_KEYS as readonly string[]).includes(k)
export type LiveConnectorKey = (typeof LIVE_CONNECTOR_KEYS)[number]
export const isLiveConnectorKey = (k: string): k is LiveConnectorKey => (LIVE_CONNECTOR_KEYS as readonly string[]).includes(k)
export type ConnectorModeValue = "DISABLED" | "SIMULATION" | "LIVE"
