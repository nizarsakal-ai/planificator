/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-8B : sources RÉELLES en lecture seule, au format des éléments du lot F.
 *
 * - Shopify (Admin REST 2026-10) : commandes et clients, lecture incrémentale par `since_id` (curseur `sid:<id>`).
 *   Correctifs du 22/11/2026 : version d'API prise en charge (2024-10 n'était plus servie par Shopify, qui retombe alors
 *   sur la plus ancienne version supportée) ; commandes SANS donnée personnelle (le champ `customer` n'est plus demandé) ;
 *   seau de débit lu (`X-Shopify-Shop-Api-Call-Limit`) : au-delà de 75 %, pause d'une seconde avant la requête suivante.
 * - Mailchimp (Marketing API 3.0) : membres d'une audience, relecture complète par pages (`off:<n>`, puis curseur effacé).
 * - Slack (Web API) : canaux publics non archivés, relecture complète (`nc:<curseur base64url>`, puis effacé). Aucun envoi.
 * - Google Agenda (Calendar API v3, LOT-8C) : événements de l'agenda principal, lecture complète depuis 30 jours puis
 *   incrémentale par jeton de synchronisation (`gs:` jeton de page, `gt:` jeton de synchronisation, encodés base64url) ;
 *   un jeton périmé (410) relance une lecture complète. Aucun participant, aucune description, aucun envoi.
 * Chaque élément est réduit aux champs utiles, sans caractère de contrôle, chaînes tronquées : il passe `checkItem` du lot F.
 * `probe` vérifie les identifiants par une requête de lecture minimale, avant leur activation dans le coffre (§9.1).
 */
import { ConnectorSourceError, PAGE_SIZE, isValidCursor, type LiveConnectorKey, type SourceItem, type SourceValue } from "@/lib/connectors/connectors.core"
import { liveHost, type LiveConfig } from "@/lib/integration/connectors/live/live-catalog"
import { liveGetJson, type FetchLike } from "@/lib/integration/connectors/live/live-http"

// Dernière version stable au 22/11/2026, prise en charge au moins 12 mois (documentation Shopify « API versioning »).
export const SHOPIFY_API_VERSION = "2026-10"
/** Part du seau de débit Shopify à partir de laquelle on marque une pause avant la requête suivante. */
export const SHOPIFY_THROTTLE_RATIO = 0.75
export const SHOPIFY_THROTTLE_PAUSE_MS = 1000

export interface LiveSourceOptions { sleep?: (ms: number) => Promise<void>; now?: () => Date }
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** « 32/40 » ⇒ 0,8 ; toute autre forme ⇒ 0. */
export function bucketUsage(header: string | null): number {
  const m = header ? /^(\d{1,4})\/(\d{1,4})$/.exec(header.trim()) : null
  return m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : 0
}

export interface LivePage { items: SourceItem[]; cursor: string | null; hasMore: boolean }
export interface LiveSource {
  probe(): Promise<void>
  fetchPage(resource: string, cursor: string | null): Promise<LivePage>
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g
const text = (v: unknown, max = 200): SourceValue => (typeof v === "string" ? v.replace(CONTROL, " ").trim().slice(0, max) : null)
const day = (v: unknown): SourceValue => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null)
const intOrNull = (v: unknown): SourceValue => (typeof v === "number" && Number.isSafeInteger(v) ? v : null)
function cents(v: unknown): SourceValue {
  if (typeof v !== "string" || !/^\d{1,12}(?:\.\d{1,2})?$/.test(v)) return null
  const [u, d = ""] = v.split(".")
  return Number(u) * 100 + Number((d + "00").slice(0, 2))
}
function externalId(v: unknown): string {
  const s = typeof v === "number" && Number.isSafeInteger(v) ? String(v) : typeof v === "string" ? v : ""
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(s)) throw new ConnectorSourceError("SOURCE_ITEM_INVALID")
  return s
}
const arrayOf = (v: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(v)) throw new ConnectorSourceError("SOURCE_UNAVAILABLE")
  return v.filter((x): x is Record<string, unknown> => x !== null && typeof x === "object")
}
function readCursor(prefix: string, cursor: string | null): string | null {
  if (cursor === null) return null
  if (!isValidCursor(cursor) || !cursor.startsWith(`${prefix}:`)) throw new ConnectorSourceError("WATERMARK_INVALID")
  return cursor.slice(prefix.length + 1)
}

function shopifySource(secret: string, config: LiveConfig, fetchImpl: FetchLike, opts: LiveSourceOptions): LiveSource {
  const host = liveHost("shopify", config)
  const headers = { "X-Shopify-Access-Token": secret }
  const base = `/admin/api/${SHOPIFY_API_VERSION}`
  const sleep = opts.sleep ?? defaultSleep
  let throttle = false
  const onHeaders = (h: (name: string) => string | null) => { throttle = bucketUsage(h("x-shopify-shop-api-call-limit")) >= SHOPIFY_THROTTLE_RATIO }
  const get = async (path: string, query: Record<string, string | number | undefined>) => {
    if (throttle) await sleep(SHOPIFY_THROTTLE_PAUSE_MS)
    return liveGetJson(fetchImpl, { host, path, query, headers, onHeaders })
  }
  return {
    async probe() { await get(`${base}/shop.json`, { fields: "id" }) },
    async fetchPage(resource, cursor) {
      const since = readCursor("sid", cursor)
      if (since !== null && !/^\d{1,20}$/.test(since)) throw new ConnectorSourceError("WATERMARK_INVALID")
      if (resource === "orders") {
        // Aucune donnée personnelle dans les commandes : le client est rattaché par la ressource « clients », pas ici.
        const j = await get(`${base}/orders.json`, { status: "any", limit: PAGE_SIZE, since_id: since ?? undefined, fields: "id,name,created_at,total_price,currency,financial_status" })
        const rows = arrayOf(j.orders)
        const items = rows.map((o): SourceItem => ({
          externalId: externalId(o.id),
          data: { number: text(o.name, 60), totalCents: cents(o.total_price), currency: text(o.currency, 3), status: text(o.financial_status, 40), orderedOn: day(o.created_at) },
        }))
        return page(items, since, "sid")
      }
      if (resource === "customers") {
        const j = await get(`${base}/customers.json`, { limit: PAGE_SIZE, since_id: since ?? undefined, fields: "id,first_name,last_name,email,orders_count" })
        const items = arrayOf(j.customers).map((c): SourceItem => ({
          externalId: externalId(c.id),
          data: { name: text([c.first_name, c.last_name].filter((x) => typeof x === "string" && x).join(" ")), email: text(c.email, 254), ordersCount: intOrNull(c.orders_count) },
        }))
        return page(items, since, "sid")
      }
      throw new ConnectorSourceError("SOURCE_ITEM_INVALID")
    },
  }
  /** `since_id` : le curseur avance au plus grand identifiant reçu ; page pleine ⇒ il en reste. */
  function page(items: SourceItem[], since: string | null, prefix: string): LivePage {
    const last = items.reduce<string | null>((m, i) => (m === null || BigInt(i.externalId) > BigInt(m) ? i.externalId : m), since)
    return { items, cursor: last === null ? null : `${prefix}:${last}`, hasMore: items.length >= PAGE_SIZE }
  }
}

function mailchimpSource(secret: string, config: LiveConfig, fetchImpl: FetchLike): LiveSource {
  const host = liveHost("mailchimp", config)
  const headers = { authorization: `Basic ${Buffer.from(`planificator:${secret}`).toString("base64")}` }
  const list = `/3.0/lists/${config.audienceId}`
  return {
    async probe() { await liveGetJson(fetchImpl, { host, path: list, query: { fields: "id" }, headers }) },
    async fetchPage(resource, cursor) {
      if (resource !== "contacts") throw new ConnectorSourceError("SOURCE_ITEM_INVALID")
      const raw = readCursor("off", cursor)
      const offset = raw === null ? 0 : /^\d{1,7}$/.test(raw) ? Number(raw) : (() => { throw new ConnectorSourceError("WATERMARK_INVALID") })()
      const j = await liveGetJson(fetchImpl, { host, path: `${list}/members`, query: { count: PAGE_SIZE, offset, fields: "members.id,members.email_address,members.status,members.timestamp_opt,total_items" }, headers })
      const items = arrayOf(j.members).map((m): SourceItem => ({
        externalId: externalId(m.id),
        data: { email: text(m.email_address, 254), consent: m.status === "subscribed", status: text(m.status, 20), subscribedOn: day(m.timestamp_opt) },
      }))
      const total = typeof j.total_items === "number" ? j.total_items : 0
      const next = offset + items.length
      const hasMore = items.length > 0 && next < total
      return { items, cursor: hasMore ? `off:${next}` : null, hasMore }
    },
  }
}

function slackSource(secret: string, fetchImpl: FetchLike): LiveSource {
  const host = "slack.com"
  const headers = { authorization: `Bearer ${secret}` }
  /** Slack répond 200 avec `ok: false` : les erreurs d'authentification et de limite sont relues ici. */
  const check = (j: Record<string, unknown>) => {
    if (j.ok === true) return
    const e = typeof j.error === "string" ? j.error : ""
    if (["invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired", "missing_scope", "no_permission"].includes(e)) throw new ConnectorSourceError("AUTH_FAILED")
    if (e === "ratelimited") throw new ConnectorSourceError("RATE_LIMITED")
    throw new ConnectorSourceError("SOURCE_UNAVAILABLE")
  }
  return {
    async probe() { check(await liveGetJson(fetchImpl, { host, path: "/api/auth.test", headers })) },
    async fetchPage(resource, cursor) {
      if (resource !== "channels") throw new ConnectorSourceError("SOURCE_ITEM_INVALID")
      const raw = readCursor("nc", cursor)
      const slackCursor = raw === null ? undefined : Buffer.from(raw, "base64url").toString("utf8")
      const j = await liveGetJson(fetchImpl, { host, path: "/api/conversations.list", query: { limit: PAGE_SIZE, exclude_archived: "true", types: "public_channel", cursor: slackCursor }, headers })
      check(j)
      const items = arrayOf(j.channels).map((c): SourceItem => ({ externalId: externalId(c.id), data: { name: text(c.name, 80), members: intOrNull(c.num_members) } }))
      const meta = (j.response_metadata ?? {}) as Record<string, unknown>
      const next = typeof meta.next_cursor === "string" ? meta.next_cursor : ""
      if (!next) return { items, cursor: null, hasMore: false }
      const encoded = `nc:${Buffer.from(next, "utf8").toString("base64url")}`
      if (!isValidCursor(encoded)) throw new ConnectorSourceError("SOURCE_UNAVAILABLE")
      return { items, cursor: encoded, hasMore: true }
    },
  }
}

/** Fenêtre de la première lecture Google Agenda (et de toute relecture complète). */
export const GOOGLE_CALENDAR_LOOKBACK_DAYS = 30

function googleCalendarSource(accessToken: string, config: LiveConfig, fetchImpl: FetchLike, opts: LiveSourceOptions): LiveSource {
  const host = liveHost("google_calendar", config)
  const headers = { authorization: `Bearer ${accessToken}` }
  const path = `/calendar/v3/calendars/${config.calendarId}/events`
  const fields = "items(id,status,summary,location,start,end),nextPageToken,nextSyncToken"
  const now = opts.now ?? (() => new Date())
  // Curseur `gc:<base64url JSON>` : k = f (page d'une lecture complète, avec sa fenêtre m), i (page d'une lecture
  // incrémentale), s (jeton de synchronisation). Les paramètres d'une suite de pages restent ceux de la première page.
  type GState = { k: "f" | "i" | "s"; t: string; m?: string }
  const enc = (st: GState) => {
    const c = `gc:${Buffer.from(JSON.stringify(st), "utf8").toString("base64url")}`
    if (!isValidCursor(c)) throw new ConnectorSourceError("SOURCE_UNAVAILABLE")
    return c
  }
  const dec = (c: string): GState => {
    let v: unknown
    try { v = JSON.parse(Buffer.from(c.slice(3), "base64url").toString("utf8")) } catch { throw new ConnectorSourceError("WATERMARK_INVALID") }
    const o = v as Record<string, unknown> | null
    if (!o || !["f", "i", "s"].includes(o.k as string) || typeof o.t !== "string" || !o.t || (o.k === "f" && typeof o.m !== "string")) throw new ConnectorSourceError("WATERMARK_INVALID")
    return o as GState
  }
  const when = (v: unknown): { at: SourceValue; allDay: boolean } => {
    const o = (v ?? {}) as Record<string, unknown>
    if (typeof o.dateTime === "string" && /^\d{4}-\d{2}-\d{2}T/.test(o.dateTime)) return { at: o.dateTime.slice(0, 25), allDay: false }
    if (typeof o.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.date)) return { at: o.date, allDay: true }
    return { at: null, allDay: false }
  }
  const read = async (query: Record<string, string | undefined>, pageKind: "f" | "i", timeMin?: string): Promise<LivePage> => {
    const j = await liveGetJson(fetchImpl, { host, path, query: { ...query, timeMin, maxResults: PAGE_SIZE, singleEvents: "true", showDeleted: "true", fields }, headers })
    const items = arrayOf(j.items).map((e): SourceItem => {
      const start = when(e.start), end = when(e.end)
      const cancelled = e.status === "cancelled"
      return { externalId: externalId(e.id), data: { title: cancelled ? null : text(e.summary), startsAt: start.at, endsAt: end.at, allDay: start.allDay, location: cancelled ? null : text(e.location), cancelled } }
    })
    if (typeof j.nextPageToken === "string" && j.nextPageToken) return { items, cursor: enc({ k: pageKind, t: j.nextPageToken, m: timeMin }), hasMore: true }
    if (typeof j.nextSyncToken === "string" && j.nextSyncToken) return { items, cursor: enc({ k: "s", t: j.nextSyncToken }), hasMore: false }
    return { items, cursor: null, hasMore: false }
  }
  const full = () => read({}, "f", new Date(now().getTime() - GOOGLE_CALENDAR_LOOKBACK_DAYS * 86_400_000).toISOString())
  return {
    async probe() { await liveGetJson(fetchImpl, { host, path: `/calendar/v3/calendars/${config.calendarId}`, query: { fields: "id" }, headers }) },
    async fetchPage(resource, cursor) {
      if (resource !== "events") throw new ConnectorSourceError("SOURCE_ITEM_INVALID")
      if (cursor === null) return full()
      if (!isValidCursor(cursor) || !cursor.startsWith("gc:")) throw new ConnectorSourceError("WATERMARK_INVALID")
      const st = dec(cursor)
      try {
        if (st.k === "f") return await read({ pageToken: st.t }, "f", st.m)
        if (st.k === "i") return await read({ pageToken: st.t }, "i")
        return await read({ syncToken: st.t }, "i")
      } catch (e) {
        // 410 : jeton périmé ⇒ relecture complète (les éléments inchangés restent « inchangés », rien n'est doublé).
        if (e instanceof ConnectorSourceError && e.code === "WATERMARK_INVALID") return full()
        throw e
      }
    },
  }
}

/** Source réelle d'un connecteur, à partir du secret résolu par le coffre et de la configuration validée. */
export function createLiveSource(key: LiveConnectorKey, secret: string, config: LiveConfig, fetchImpl: FetchLike, opts: LiveSourceOptions = {}): LiveSource {
  switch (key) {
    case "shopify": return shopifySource(secret, config, fetchImpl, opts)
    case "mailchimp": return mailchimpSource(secret, config, fetchImpl)
    case "slack": return slackSource(secret, fetchImpl)
    case "google_calendar": return googleCalendarSource(secret, config, fetchImpl, opts)
  }
}
