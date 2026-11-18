import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  ADDRESS_MAX_SUGGESTIONS,
  buildIgnCompletionUrl,
  createRateLimiter,
  fetchAddressSuggestions,
  normalizeAddressQuery,
  parseIgnCompletionResponse,
  shouldSearchAddress,
} from "@/lib/address/ign-address-completion"

const unlimited = { tryAcquire: () => true }
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const IGN_SAMPLE = {
  status: "OK",
  results: [
    { country: "StreetAddress", city: "Paris", x: 2.3488, y: 48.8534, zipcode: "75001", street: "Rue de Rivoli", kind: "housenumber", fulltext: "12 Rue de Rivoli, 75001 Paris", classification: 7 },
    { country: "StreetAddress", city: "Montreuil", x: 2.44, y: 48.86, zipcode: "93100", street: "Rue de Paris", fulltext: "Rue de Paris, 93100 Montreuil" },
  ],
}

describe("seuil de 3 caractères", () => {
  it("compte les caractères hors espaces de début et de fin", () => {
    assert.equal(shouldSearchAddress(""), false)
    assert.equal(shouldSearchAddress("12"), false)
    assert.equal(shouldSearchAddress("   12   "), false)
    assert.equal(shouldSearchAddress(" 12 r "), true)
    assert.equal(shouldSearchAddress("abc"), true)
    assert.equal(normalizeAddressQuery("  12   rue  "), "12 rue")
  })
  it("sous le seuil, aucun appel réseau", async () => {
    let calls = 0
    const r = await fetchAddressSuggestions("  ab ", { fetchFn: async () => { calls++; return jsonResponse(IGN_SAMPLE) }, limiter: unlimited })
    assert.equal(calls, 0)
    assert.equal(r.status, "empty")
  })
})

describe("URL IGN", () => {
  it("n'envoie que le texte saisi, le type et le nombre de réponses", () => {
    const url = new URL(buildIgnCompletionUrl("  12 rue de Rivoli & co "))
    assert.equal(url.origin + url.pathname, "https://data.geopf.fr/geocodage/completion/")
    assert.deepEqual([...url.searchParams.keys()].sort(), ["maximumResponses", "text", "type"])
    assert.equal(url.searchParams.get("text"), "12 rue de Rivoli & co")
    assert.equal(url.searchParams.get("type"), "StreetAddress")
    assert.equal(url.searchParams.get("maximumResponses"), "5")
  })
  it("requête sans cookie ni referrer", async () => {
    let init: RequestInit | undefined
    await fetchAddressSuggestions("rivoli", { fetchFn: async (_u, i) => { init = i; return jsonResponse(IGN_SAMPLE) }, limiter: unlimited })
    assert.equal(init?.credentials, "omit")
    assert.equal(init?.referrerPolicy, "no-referrer")
    assert.equal(init?.method, "GET")
  })
})

describe("lecture de la réponse", () => {
  it("numéro, voie, code postal, commune", () => {
    const [a, b] = parseIgnCompletionResponse(IGN_SAMPLE)
    assert.deepEqual(
      { label: a.label, n: a.housenumber, street: a.street, cp: a.postcode, city: a.city, lat: a.latitude, lon: a.longitude },
      { label: "12 Rue de Rivoli, 75001 Paris", n: "12", street: "Rue de Rivoli", cp: "75001", city: "Paris", lat: 48.8534, lon: 2.3488 },
    )
    assert.equal(b.housenumber, null)
    assert.equal(b.label, "Rue de Paris, 93100 Montreuil")
  })
  it("au plus 5 suggestions, doublons retirés, entrées invalides ignorées", () => {
    const results = [null, 3, {}, ...Array.from({ length: 8 }, (_, i) => ({ street: `Rue ${i}`, zipcode: "75001", city: "Paris" })), { street: "Rue 0", zipcode: "75001", city: "Paris" }]
    const out = parseIgnCompletionResponse({ results })
    assert.equal(out.length, ADDRESS_MAX_SUGGESTIONS)
    assert.equal(new Set(out.map((s) => s.label)).size, out.length)
    assert.deepEqual(parseIgnCompletionResponse(null), [])
    assert.deepEqual(parseIgnCompletionResponse({ results: "x" }), [])
  })
})

describe("pannes : la saisie manuelle reste possible", () => {
  it("résultat vide", async () => {
    const r = await fetchAddressSuggestions("zzzz", { fetchFn: async () => jsonResponse({ results: [] }), limiter: unlimited })
    assert.deepEqual(r, { status: "empty", suggestions: [] })
  })
  it("HTTP 429 → limite d'appels", async () => {
    const r = await fetchAddressSuggestions("rivoli", { fetchFn: async () => jsonResponse({}, 429), limiter: unlimited })
    assert.equal(r.status, "rate_limited")
  })
  it("HTTP 500 et JSON invalide → erreur", async () => {
    assert.equal((await fetchAddressSuggestions("rivoli", { fetchFn: async () => jsonResponse({}, 503), limiter: unlimited })).status, "error")
    assert.equal((await fetchAddressSuggestions("rivoli", { fetchFn: async () => new Response("<html>"), limiter: unlimited })).status, "error")
  })
  it("erreur réseau → erreur", async () => {
    const r = await fetchAddressSuggestions("rivoli", { fetchFn: async () => { throw new TypeError("Failed to fetch") }, limiter: unlimited })
    assert.equal(r.status, "error")
  })
  it("lenteur → délai dépassé", async () => {
    const slow: typeof fetch = (_u, init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
    const r = await fetchAddressSuggestions("rivoli", { fetchFn: slow, limiter: unlimited, timeoutMs: 20 })
    assert.equal(r.status, "timeout")
  })
  it("annulation par une frappe plus récente → aborted", async () => {
    const slow: typeof fetch = (_u, init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
    const controller = new AbortController()
    const p = fetchAddressSuggestions("rivoli", { fetchFn: slow, limiter: unlimited, signal: controller.signal })
    controller.abort()
    assert.equal((await p).status, "aborted")
  })
})

describe("limite IGN de 10 requêtes/s/IP", () => {
  it("fenêtre glissante d'une seconde", () => {
    let t = 0
    const limiter = createRateLimiter(8, () => t)
    for (let i = 0; i < 8; i++) assert.equal(limiter.tryAcquire(), true)
    assert.equal(limiter.tryAcquire(), false)
    t = 999
    assert.equal(limiter.tryAcquire(), false)
    t = 1000
    assert.equal(limiter.tryAcquire(), true)
  })
  it("au-delà du quota, aucun appel n'est émis", async () => {
    let calls = 0
    const limiter = createRateLimiter(8, () => 0)
    const fetchFn: typeof fetch = async () => { calls++; return jsonResponse(IGN_SAMPLE) }
    const results = await Promise.all(Array.from({ length: 12 }, () => fetchAddressSuggestions("rivoli", { fetchFn, limiter })))
    assert.equal(calls, 8)
    assert.equal(results.filter((r) => r.status === "rate_limited").length, 4)
  })
})
