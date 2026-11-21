/**
 * Lot F Planificator V2 : centre de connecteurs — règles pures, catalogue fermé, double fictif, AUCUN appel réseau
 * (compteur nul), codes d'erreur sans fuite.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { describe, it } from "node:test"
import { CONNECTORS, CONNECTOR_KEYS, connectorByKey, isConnectorKey } from "@/lib/connectors/catalog"
import { canonicalJson, sha256Hex } from "@/lib/connectors/canonical"
import { resolveConnectorAccessCore } from "@/lib/connectors/access"
import { resolveAssistantAccessCore } from "@/lib/assistant/access"
import { ConnectorSourceError, SYNC_ERROR_CODES, SYNC_ERROR_LABEL, checkItem, decideUpsert, parseWatermark, serializeWatermark, toErrorCode } from "@/lib/connectors/connectors.core"
import { SIMULATED_COUNT, simulatedItem, simulationTransport } from "@/lib/connectors/transport"
import { isConnectorCenterEnabled } from "@/lib/connectors/connector-feature-flag"

const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")

describe("catalogue et drapeau", () => {
  it("catalogue fermé de dix connecteurs (v4), aucun adaptateur réel, aucune valeur d'identifiant", () => {
    assert.deepEqual([...CONNECTOR_KEYS], ["shopify", "stripe", "mailchimp", "meta_ads", "google_ads", "slack", "chatgpt", "google_calendar", "outlook", "sharepoint"])
    assert.ok(CONNECTORS.every((c) => c.realAdapter === false && c.resources.length > 0))
    assert.equal(isConnectorKey("shopify"), true)
    assert.equal(isConnectorKey("chatgpt"), true)
    assert.equal(isConnectorKey("platform.mail.legacy"), false, "la plateforme existante n'est pas pilotée ici")
    assert.equal(isConnectorKey("SHOPIFY"), false)
    assert.equal(isConnectorKey("openai"), false)
    const sql = readFileSync("prisma/migrations/20261119120000_v2_lot_f_connectors_assistant/migration.sql", "utf8")
    // Les TROIS listes fermées de la migration (réglages, exécutions, zone de transit) correspondent exactement au catalogue.
    const lists = [...sql.matchAll(/"connectorKey" IN \(([^)]+)\)/g)].map((m) => m[1].split(",").map((s) => s.trim().replace(/'/g, "")))
    assert.equal(lists.length, 3)
    for (const inDb of lists) assert.deepEqual(inDb, [...CONNECTOR_KEYS], "même liste fermée en base")
  })
  it("v4 : ressources des quatre nouveaux connecteurs ; ChatGPT sans accès réel promis", () => {
    assert.deepEqual(
      CONNECTORS.filter((c) => ["chatgpt", "google_calendar", "outlook", "sharepoint"].includes(c.key)).map((c) => [c.key, c.label, c.resources.map((r) => r.key)]),
      [["chatgpt", "ChatGPT", ["conversations"]], ["google_calendar", "Google Agenda", ["events"]], ["outlook", "Microsoft Outlook", ["messages"]], ["sharepoint", "Microsoft SharePoint", ["documents"]]],
    )
    const chatgpt = connectorByKey("chatgpt")
    assert.match(chatgpt.credentialsRequired.join(" "), /à qualifier/, "mode réel à qualifier")
    assert.match(chatgpt.description, /aucun historique utilisateur/)
  })
  it("drapeau absent ou différent de « true » ⇒ module désactivé", () => {
    assert.equal(isConnectorCenterEnabled({}), false)
    assert.equal(isConnectorCenterEnabled({ CONNECTOR_CENTER_ENABLED: "1" }), false)
    assert.equal(isConnectorCenterEnabled({ CONNECTOR_CENTER_ENABLED: "true" }), true)
  })
})

describe("accès : deux profils autorisés (ADMIN, SUPER_ADMIN) dans la seule société pilote", () => {
  for (const [name, resolve] of [["connecteurs", resolveConnectorAccessCore], ["assistant", resolveAssistantAccessCore]] as const) {
    it(`${name} : ADMIN et SUPER_ADMIN de la société pilote admis ; autres rôles refusés ; hors cible, sans cible ou sans société MODULE_DISABLED ; sans session UNAUTHENTICATED`, () => {
      for (const role of ["ADMIN", "SUPER_ADMIN"]) {
        assert.deepEqual(resolve("c1", { user: { id: "u1", role, companyId: "c1" } }), { ok: true, context: { userId: "u1", companyId: "c1", role } }, role)
      }
      for (const role of ["TEAM_LEADER", "EMPLOYEE", "CLIENT", null]) {
        assert.deepEqual(resolve("c1", { user: { id: "u1", role, companyId: "c1" } }), { ok: false, reason: "FORBIDDEN" }, String(role))
      }
      for (const companyId of ["c2", " ", " c1", null]) {
        assert.deepEqual(resolve("c1", { user: { id: "u1", role: "SUPER_ADMIN", companyId } }), { ok: false, reason: "MODULE_DISABLED" }, `société ${JSON.stringify(companyId)}`)
      }
      assert.deepEqual(resolve("c1", null), { ok: false, reason: "UNAUTHENTICATED" })
      assert.deepEqual(resolve(null, { user: { id: "u1", role: "ADMIN", companyId: "c1" } }), { ok: false, reason: "MODULE_DISABLED" }, "cible contrôlée avant la session")
    })
  }
})

describe("forme canonique locale au lot F (aucune dépendance au lot D)", () => {
  it("clés triées, sans espaces, entiers sûrs seulement, indéfini refusé ; empreinte SHA-256 du texte canonique", () => {
    assert.equal(canonicalJson({ b: 2, a: "1", c: null, d: [true, { z: 1, y: "é" }] }), '{"a":"1","b":2,"c":null,"d":[true,{"y":"é","z":1}]}')
    assert.throws(() => canonicalJson({ n: 1.5 }), RangeError)
    assert.throws(() => canonicalJson({ u: undefined }), TypeError)
    assert.equal(sha256Hex('{"a":"1"}'), createHash("sha256").update('{"a":"1"}', "utf8").digest("hex"))
    // Pas de normalisation NFC (contrairement à la forme canonique comptable) : la v6 du lot F n'en faisait pas.
    assert.notEqual(canonicalJson({ s: "é" }), canonicalJson({ s: "é" }))
  })
  it("aucun module du lot F n'importe le lot D (réserves) ni la forme canonique comptable", () => {
    const files = [
      ...readdirSync("src/lib/connectors").map((f) => `src/lib/connectors/${f}`), ...readdirSync("src/lib/assistant").map((f) => `src/lib/assistant/${f}`),
      "src/lib/actions/connector.actions.ts", "src/lib/actions/assistant.actions.ts", "src/app/(dashboard)/connecteurs/page.tsx", "src/app/(dashboard)/assistant/page.tsx",
    ]
    for (const f of files) {
      const c = code(readFileSync(f, "utf8"))
      assert.doesNotMatch(c, /@\/lib\/reserves|worksite_reserves|worksiteReserve|reception_reports|@\/lib\/accounting\/engine\/canonical/, f)
    }
  })
})

describe("curseurs", () => {
  const shopify = connectorByKey("shopify")
  it("lecture stricte : ressources du connecteur seulement, curseurs bornés ; sérialisation canonique", () => {
    assert.deepEqual(parseWatermark(shopify, null), {})
    assert.deepEqual(parseWatermark(shopify, '{"orders":"seq:12","customers":"seq:3"}'), { orders: "seq:12", customers: "seq:3" })
    for (const bad of ["{", "[]", "null", '{"payments":"seq:1"}', '{"orders":12}', '{"orders":"seq 1"}', `{"orders":"${"x".repeat(1001)}"}`]) { // LOT-8C : curseurs bornés à 1 000 caractères (jetons Google)
      assert.throws(() => parseWatermark(shopify, bad), (e: unknown) => e instanceof ConnectorSourceError && e.code === "WATERMARK_INVALID", bad)
    }
    assert.equal(serializeWatermark({ orders: "seq:2", customers: "seq:1" }), '{"customers":"seq:1","orders":"seq:2"}')
    assert.equal(serializeWatermark({}), null)
  })
})

describe("éléments reçus et idempotence", () => {
  it("empreinte indépendante de l'ordre des champs ; même contenu ⇒ inchangé, contenu différent ⇒ nouvelle version", () => {
    const a = checkItem({ externalId: "x1", data: { b: 2, a: "1", c: null, d: true } })
    const b = checkItem({ externalId: "x1", data: { d: true, c: null, a: "1", b: 2 } })
    assert.equal(a.hash, b.hash)
    assert.match(a.hash, /^[0-9a-f]{64}$/)
    const c = checkItem({ externalId: "x1", data: { b: 3, a: "1", c: null, d: true } })
    assert.equal(decideUpsert(undefined, a.hash), "created")
    assert.equal(decideUpsert(a.hash, b.hash), "unchanged")
    assert.equal(decideUpsert(a.hash, c.hash), "updated")
  })
  it("refus : identifiant vide, long ou à caractère de contrôle ; champs non scalaires, décimaux, trop nombreux ou trop gros", () => {
    const bad = [
      null, "x", { externalId: "", data: {} }, { externalId: "a".repeat(201), data: {} }, { externalId: "a\nb", data: {} }, { externalId: "a", data: [] },
      { externalId: "a", data: { n: 1.5 } }, { externalId: "a", data: { o: { x: 1 } } }, { externalId: "a", data: { "1bad": 1 } }, { externalId: "a", data: { s: "x".repeat(501) } },
      { externalId: "a", data: Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`f${i}`, i])) },
      { externalId: "a", data: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, "é".repeat(250)])) },
    ]
    for (const item of bad) assert.throws(() => checkItem(item), (e: unknown) => e instanceof ConnectorSourceError && e.code === "SOURCE_ITEM_INVALID", JSON.stringify(item)?.slice(0, 60))
  })
  it("code d'erreur stable : jamais le message d'une erreur quelconque (qui pourrait contenir un secret)", () => {
    assert.equal(toErrorCode(new Error("token=sk_live_SECRET")), "INTERNAL_ERROR")
    assert.equal(toErrorCode(new ConnectorSourceError("SOURCE_UNAVAILABLE")), "SOURCE_UNAVAILABLE")
    for (const c of SYNC_ERROR_CODES) assert.ok(SYNC_ERROR_LABEL[c].length > 10)
    assert.ok(Object.values(SYNC_ERROR_LABEL).every((l) => !/sk_|token=|secret/i.test(l)))
  })
})

describe("double fictif (simulation)", () => {
  it("déterministe, paginé, toutes les ressources du catalogue couvertes, données marquées fictives", async () => {
    for (const c of CONNECTORS) for (const r of c.resources) {
      const p1 = await simulationTransport.fetchPage({ connectorKey: c.key, resource: r.key, cursor: null, limit: 5 })
      assert.deepEqual([p1.items.length, p1.cursor, p1.hasMore], [5, "seq:5", true], `${c.key}/${r.key}`)
      const p2 = await simulationTransport.fetchPage({ connectorKey: c.key, resource: r.key, cursor: "seq:5", limit: 50 })
      assert.deepEqual([p2.items.length, p2.cursor, p2.hasMore], [SIMULATED_COUNT - 5, `seq:${SIMULATED_COUNT}`, false])
      const p3 = await simulationTransport.fetchPage({ connectorKey: c.key, resource: r.key, cursor: p2.cursor, limit: 50 })
      assert.deepEqual([p3.items.length, p3.hasMore], [0, false], "rattrapé : rien de nouveau")
      for (const it of [...p1.items, ...p2.items]) {
        const v = checkItem(it)
        assert.equal(v.data.fictitious, true)
        for (const val of Object.values(v.data)) if (typeof val === "string" && val.includes("@")) assert.match(val, /@exemple\.invalid$/, "adresse réservée, jamais réelle")
      }
      assert.deepEqual(simulatedItem(c.key, r.key, 3), simulatedItem(c.key, r.key, 3))
      assert.equal(new Set([...p1.items, ...p2.items].map((i) => i.externalId)).size, SIMULATED_COUNT)
    }
    await assert.rejects(simulationTransport.fetchPage({ connectorKey: "shopify", resource: "orders", cursor: "page-2", limit: 5 }), (e: unknown) => e instanceof ConnectorSourceError && e.code === "WATERMARK_INVALID")
  })
  it("v4 : contenu des nouvelles ressources (métadonnées seulement, dates cohérentes, aucun lien ni contenu)", () => {
    for (let i = 1; i <= SIMULATED_COUNT; i++) {
      const c = checkItem(simulatedItem("chatgpt", "conversations", i)).data
      assert.deepEqual(Object.keys(c).sort(), ["createdOn", "fictitious", "title"], "titre et date seulement : aucun message importé")
      const e = checkItem(simulatedItem("google_calendar", "events", i)).data
      const start = new Date(e.startsAt as string), end = new Date(e.endsAt as string)
      assert.ok(!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()), "début et fin explicites")
      assert.ok(start < end, "fin après début")
      assert.equal((e.startsAt as string).slice(0, 10), (e.endsAt as string).slice(0, 10), "même jour")
      const m = checkItem(simulatedItem("outlook", "messages", i)).data
      assert.match(m.from as string, /@exemple\.invalid$/)
      assert.match(m.subject as string, /fictive/)
      const d = checkItem(simulatedItem("sharepoint", "documents", i)).data
      assert.match(d.name as string, /^document-chantier-fictif-\d{3}\.(?:pdf|docx|xlsx|jpg)$/)
      assert.equal((d.name as string).endsWith(`.${d.fileType}`), true)
      for (const v of [c, e, m, d].flatMap((x) => Object.values(x))) if (typeof v === "string") assert.doesNotMatch(v, /https?:|\/\//, "aucun lien ni téléchargement")
    }
  })
  it("AUCUN appel réseau : fetch remplacé par un compteur, toutes les ressources lues jusqu'au bout ⇒ compteur nul", async () => {
    const original = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => { calls++; throw new Error("réseau interdit en test") }) as typeof fetch
    try {
      for (const c of CONNECTORS) for (const r of c.resources) {
        let cursor: string | null = null
        for (let i = 0; i < 10; i++) {
          const p = await simulationTransport.fetchPage({ connectorKey: c.key, resource: r.key, cursor, limit: 4 })
          cursor = p.cursor
          if (!p.hasMore) break
        }
      }
    } finally { globalThis.fetch = original }
    assert.equal(calls, 0)
  })
  it("contrôle statique : aucun module réseau, aucun secret ni variable d'environnement dans le module connecteurs", () => {
    const files = [...readdirSync("src/lib/connectors").map((f) => `src/lib/connectors/${f}`), "src/lib/actions/connector.actions.ts", "src/app/(dashboard)/connecteurs/page.tsx"]
    for (const f of files) {
      const c = code(readFileSync(f, "utf8"))
      assert.doesNotMatch(c, /\bfetch\(|from "node:(?:http|https|net|tls|dgram)"|from "(?:http|https|net|axios|undici|got|node-fetch)"|https?:\/\/|XMLHttpRequest|WebSocket/, f)
      assert.doesNotMatch(c, /credentialsRef|\bconfig\b:\s*true|decrypt\(|encrypt\(/, f)
      if (!f.endsWith("connector-feature-flag.ts")) assert.doesNotMatch(c, /process\.env/, f)
    }
  })
})
