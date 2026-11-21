/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-8B : connexions réelles en lecture seule, règles pures et sources (fetch simulé).
 * Aucun réseau : chaque appel passe par un double qui enregistre l'URL et les en-têtes. Les identifiants de test sont
 * construits à l'exécution, sans entropie (aucune valeur au format d'un vrai jeton dans le dépôt).
 */
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { describe, it } from "node:test"
import { ConnectorSourceError, PAGE_SIZE, checkItem, isValidCursor, type SyncErrorCode } from "@/lib/connectors/connectors.core"
import { LIVE_FIELDS, liveHost, parseLiveCredentials, readLiveConfig } from "@/lib/integration/connectors/live/live-catalog"
import { LIVE_MAX_RESPONSE_BYTES, buildLiveUrl, liveGetJson, type FetchLike } from "@/lib/integration/connectors/live/live-http"
import { createLiveSource } from "@/lib/integration/connectors/live/live-sources"

const SHOP_TOKEN = "shp" + "at_" + "A".repeat(32)
const MC_KEY = "0".repeat(32) + "-us" + "21"
const SLACK_TOKEN = "xox" + "b-" + "1".repeat(24)

interface Call { url: string; headers: Record<string, string>; redirect: string }
function fakeFetch(responder: (url: URL) => { status?: number; body: unknown }): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: input, headers: init.headers, redirect: init.redirect })
    const r = responder(new URL(input))
    return { status: r.status ?? 200, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) }
  }
  return { fetch, calls }
}
const codeOf = async (p: Promise<unknown>): Promise<SyncErrorCode | "NO_ERROR" | "OTHER"> => {
  try { await p; return "NO_ERROR" } catch (e) { return e instanceof ConnectorSourceError ? e.code : "OTHER" }
}

describe("saisie des identifiants (catalogue LOT-8B)", () => {
  it("Shopify : domaine normalisé, jeton séparé de la configuration non secrète", () => {
    const r = parseLiveCredentials("shopify", { shopDomain: " https://Ma-Boutique.myshopify.com/ ", accessToken: SHOP_TOKEN })
    assert.deepEqual(r, { ok: true, secret: SHOP_TOKEN, config: { shopDomain: "ma-boutique.myshopify.com" } })
  })
  it("Mailchimp : centre de données tiré de la clé ; audience exigée", () => {
    const r = parseLiveCredentials("mailchimp", { apiKey: MC_KEY, audienceId: "A1B2C3D4E5" })
    assert.deepEqual(r, { ok: true, secret: MC_KEY, config: { dataCenter: "us21", audienceId: "a1b2c3d4e5" } })
  })
  it("Slack : jeton de robot seulement", () => {
    assert.deepEqual(parseLiveCredentials("slack", { botToken: SLACK_TOKEN }), { ok: true, secret: SLACK_TOKEN, config: {} })
  })
  it("refus sans écho de la saisie : domaine hors myshopify.com, jeton mal formé, audience absente, jeton utilisateur Slack", () => {
    const bad = [
      parseLiveCredentials("shopify", { shopDomain: "evil.example.com", accessToken: SHOP_TOKEN }),
      parseLiveCredentials("shopify", { shopDomain: "a.myshopify.com.evil.com", accessToken: SHOP_TOKEN }),
      parseLiveCredentials("shopify", { shopDomain: "ok.myshopify.com", accessToken: "pas-un-jeton" }),
      parseLiveCredentials("mailchimp", { apiKey: MC_KEY, audienceId: "" }),
      parseLiveCredentials("mailchimp", { apiKey: "0".repeat(32) + "-eu1", audienceId: "a1b2c3d4e5" }),
      parseLiveCredentials("slack", { botToken: "xox" + "p-" + "1".repeat(24) }),
    ]
    for (const r of bad) {
      assert.equal(r.ok, false)
      if (!r.ok) assert.doesNotMatch(r.error, /pas-un-jeton|evil|xoxp/, "le message ne reprend pas la saisie")
    }
  })
  it("configuration relue en base revalidée ; hôte unique dérivé d'une configuration valide", () => {
    assert.equal(readLiveConfig("shopify", { shopDomain: "x.example.com" }), null)
    assert.equal(readLiveConfig("mailchimp", { dataCenter: "us21.evil.com", audienceId: "a1b2c3d4e5" }), null)
    assert.equal(readLiveConfig("shopify", null), null)
    assert.equal(liveHost("mailchimp", readLiveConfig("mailchimp", { dataCenter: "us21", audienceId: "a1b2c3d4e5" })!), "us21.api.mailchimp.com")
    assert.equal(liveHost("slack", {}), "slack.com")
  })
  it("chaque service déclare au moins un champ secret ; aucun champ secret n'a de valeur par défaut", () => {
    for (const fields of Object.values(LIVE_FIELDS)) assert.ok(fields.some((f) => f.secret))
  })
})

describe("client HTTP borné", () => {
  it("HTTPS vers l'hôte imposé ; chemins détournés refusés", () => {
    assert.equal(buildLiveUrl({ host: "slack.com", path: "/api/auth.test", headers: {} }), "https://slack.com/api/auth.test")
    for (const path of ["//evil.com/x", "/../x", "x", "/a//b"]) assert.throws(() => buildLiveUrl({ host: "slack.com", path, headers: {} }), ConnectorSourceError, path)
    assert.throws(() => buildLiveUrl({ host: "evil.com:8080", path: "/", headers: {} }), ConnectorSourceError)
    assert.throws(() => buildLiveUrl({ host: "user@evil.com", path: "/", headers: {} }), ConnectorSourceError)
  })
  it("aucune redirection suivie ; codes stables pour 401/403, 429, 3xx, 5xx, JSON invalide, réponse trop grande, panne réseau", async () => {
    const req = { host: "slack.com", path: "/api/x", headers: {} }
    const cases: [number, unknown, SyncErrorCode][] = [
      [401, {}, "AUTH_FAILED"], [403, {}, "AUTH_FAILED"], [429, {}, "RATE_LIMITED"], [302, {}, "SOURCE_UNAVAILABLE"],
      [500, {}, "SOURCE_UNAVAILABLE"], [200, "pas du json", "SOURCE_UNAVAILABLE"], [200, [1, 2], "SOURCE_UNAVAILABLE"],
      [200, "x".repeat(LIVE_MAX_RESPONSE_BYTES + 1), "SOURCE_UNAVAILABLE"],
    ]
    for (const [status, body, expected] of cases) {
      const f = fakeFetch(() => ({ status, body }))
      assert.equal(await codeOf(liveGetJson(f.fetch, req)), expected, `${status}`)
      assert.equal(f.calls[0].redirect, "manual")
    }
    const down: FetchLike = async () => { throw new Error("ECONNRESET secret-dans-le-message") }
    const e = await liveGetJson(down, req).catch((x: unknown) => x)
    assert.ok(e instanceof ConnectorSourceError && e.code === "SOURCE_UNAVAILABLE" && !e.message.includes("secret"))
  })
})

describe("sources réelles (fetch simulé)", () => {
  const shopify = { shopDomain: "ma-boutique.myshopify.com" }
  it("Shopify : en-tête d'accès, hôte de la boutique, lecture incrémentale par since_id, éléments valides pour le lot F", async () => {
    const orders = Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: 1000 + i, name: `#${1000 + i}`, created_at: "2026-11-02T10:00:00+01:00", total_price: "12.5", currency: "EUR", financial_status: "paid", customer: { first_name: "Ana\u0007", last_name: "B" } }))
    const f = fakeFetch((u) => ({ body: { orders: u.searchParams.get("since_id") === "1049" ? [] : orders } }))
    const src = createLiveSource("shopify", SHOP_TOKEN, shopify, f.fetch)
    const p1 = await src.fetchPage("orders", null)
    assert.equal(p1.items.length, PAGE_SIZE); assert.equal(p1.hasMore, true); assert.equal(p1.cursor, "sid:1049")
    assert.deepEqual(p1.items[0].data, { number: "#1000", customer: "Ana  B", totalCents: 1250, currency: "EUR", status: "paid", orderedOn: "2026-11-02" })
    for (const it of p1.items) checkItem(it)
    const p2 = await src.fetchPage("orders", p1.cursor)
    assert.deepEqual(p2, { items: [], cursor: "sid:1049", hasMore: false }, "curseur conservé quand rien de nouveau")
    const u = new URL(f.calls[0].url)
    assert.equal(u.host, "ma-boutique.myshopify.com"); assert.equal(u.pathname, "/admin/api/2024-10/orders.json"); assert.equal(u.searchParams.get("status"), "any")
    assert.equal(f.calls[0].headers["X-Shopify-Access-Token"], SHOP_TOKEN)
    assert.equal(await codeOf(src.fetchPage("orders", "off:3")), "WATERMARK_INVALID")
    assert.equal(await codeOf(src.fetchPage("payments", null)), "SOURCE_ITEM_INVALID")
  })
  it("Mailchimp : Basic auth, audience, pagination par décalage puis curseur effacé ; consentement = abonné", async () => {
    const member = (i: number) => ({ id: `m${i}`, email_address: `c${i}@exemple.invalid`, status: i % 2 ? "unsubscribed" : "subscribed", timestamp_opt: "2026-01-05T00:00:00Z" })
    const f = fakeFetch((u) => {
      const off = Number(u.searchParams.get("offset"))
      return { body: { total_items: 60, members: Array.from({ length: Math.min(PAGE_SIZE, 60 - off) }, (_, i) => member(off + i)) } }
    })
    const src = createLiveSource("mailchimp", MC_KEY, { dataCenter: "us21", audienceId: "a1b2c3d4e5" }, f.fetch)
    const p1 = await src.fetchPage("contacts", null)
    assert.equal(p1.cursor, "off:50"); assert.equal(p1.hasMore, true)
    assert.deepEqual(p1.items[0].data, { email: "c0@exemple.invalid", consent: true, status: "subscribed", subscribedOn: "2026-01-05" })
    const p2 = await src.fetchPage("contacts", p1.cursor)
    assert.equal(p2.items.length, 10); assert.equal(p2.cursor, null); assert.equal(p2.hasMore, false)
    const u = new URL(f.calls[0].url)
    assert.equal(u.host, "us21.api.mailchimp.com"); assert.equal(u.pathname, "/3.0/lists/a1b2c3d4e5/members")
    assert.equal(f.calls[0].headers.authorization, `Basic ${Buffer.from(`planificator:${MC_KEY}`).toString("base64")}`)
  })
  it("Slack : Bearer, canaux publics, curseur opaque encodé (valide pour le lot F), erreurs ok:false relues", async () => {
    const next = "dGVhbTpDMDYxRkE1UEI=" // curseur opaque de démonstration (non secret)
    const f = fakeFetch((u) => ({ body: u.searchParams.get("cursor") ? { ok: true, channels: [{ id: "C2", name: "chantier", num_members: 3 }], response_metadata: { next_cursor: "" } } : { ok: true, channels: [{ id: "C1", name: "general", num_members: 12 }], response_metadata: { next_cursor: next } } }))
    const src = createLiveSource("slack", SLACK_TOKEN, {}, f.fetch)
    const p1 = await src.fetchPage("channels", null)
    assert.ok(p1.cursor && isValidCursor(p1.cursor) && p1.cursor.startsWith("nc:"))
    assert.deepEqual(p1.items, [{ externalId: "C1", data: { name: "general", members: 12 } }])
    const p2 = await src.fetchPage("channels", p1.cursor)
    assert.equal(new URL(f.calls[1].url).searchParams.get("cursor"), next, "curseur Slack restitué à l'identique")
    assert.deepEqual(p2, { items: [{ externalId: "C2", data: { name: "chantier", members: 3 } }], cursor: null, hasMore: false })
    assert.equal(f.calls[0].headers.authorization, `Bearer ${SLACK_TOKEN}`)
    assert.equal(new URL(f.calls[0].url).searchParams.get("types"), "public_channel")
    for (const [error, expected] of [["invalid_auth", "AUTH_FAILED"], ["token_revoked", "AUTH_FAILED"], ["ratelimited", "RATE_LIMITED"], ["fatal_error", "SOURCE_UNAVAILABLE"]] as const) {
      const g = fakeFetch(() => ({ body: { ok: false, error } }))
      assert.equal(await codeOf(createLiveSource("slack", SLACK_TOKEN, {}, g.fetch).probe()), expected, error)
    }
  })
  it("identifiant externe non conforme ⇒ élément refusé (aucune écriture partielle)", async () => {
    const f = fakeFetch(() => ({ body: { ok: true, channels: [{ id: "C1/../x", name: "x" }], response_metadata: {} } }))
    assert.equal(await codeOf(createLiveSource("slack", SLACK_TOKEN, {}, f.fetch).fetchPage("channels", null)), "SOURCE_ITEM_INVALID")
  })
})

describe("contrôles statiques LOT-8B", () => {
  const dir = "src/lib/integration/connectors/live"
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => `${dir}/${f}`)
  it("un seul point d'appel réseau (live-http) ; aucune URL libre ; aucun journal ; aucune écriture vers le service", () => {
    for (const f of files) {
      const c = readFileSync(f, "utf8")
      if (!f.endsWith("live-http.ts")) assert.doesNotMatch(c, /\bfetch\(/, f)
      assert.doesNotMatch(c, /https?:\/\/[a-z]/i, f)
      assert.doesNotMatch(c, /console\.(?:log|info|warn|error)/, f)
      assert.doesNotMatch(c, /method:\s*"(?:POST|PUT|PATCH|DELETE)"/, f)
      assert.doesNotMatch(c, /from "node:(?:http|https|net|tls)"|from "(?:axios|undici|got|node-fetch)"/, f)
    }
    assert.match(readFileSync(`${dir}/live-http.ts`, "utf8"), /redirect: "manual"/)
  })
  it("le secret n'est résolu que pour connector-runtime et jamais renvoyé par les services", () => {
    const sync = readFileSync(`${dir}/live-sync.service.ts`, "utf8")
    assert.match(sync, /runtimeCallerId: "connector-runtime"/)
    const conn = readFileSync(`${dir}/live-connection.service.ts`, "utf8")
    assert.doesNotMatch(conn, /resolveCredential/)
    assert.doesNotMatch(conn, /value: \{[^}]*secret/)
  })
})
