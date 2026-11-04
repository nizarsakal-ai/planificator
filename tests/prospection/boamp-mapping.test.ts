/** Veille prospection — mapping BOAMP sur de vrais avis (champs autorisés uniquement), requête et pagination. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import {
  BOAMP_SELECTED_FIELDS,
  buildBoampRequestUrl,
  buildBoampWhereClause,
  fetchBoampCandidates,
  mapBoampRecord,
  normalizeDepartmentCode,
  type BoampRecord,
} from "@/lib/prospection/sources/boamp.source"

const HERE = dirname(fileURLToPath(import.meta.url))
const records = JSON.parse(readFileSync(join(HERE, "fixtures/boamp-records.json"), "utf8")) as BoampRecord[]
const byId = (id: string) => records.find((record) => record.idweb === id) as BoampRecord

describe("mapBoampRecord", () => {
  it("attribution réelle (Cité des Congrès de Nantes) → AWARD avec titulaires et avis initial lié", () => {
    const candidate = mapBoampRecord(byId("26-96170"))
    assert.ok(candidate)
    assert.equal(candidate.source, "BOAMP")
    assert.equal(candidate.kind, "AWARD")
    assert.equal(candidate.organization, "La Cité des Congrès de Nantes")
    assert.deepEqual(candidate.winners, ["PHIL EXPO", "GL EVENT LIVE GRAND OUEST", "SO BOYA"])
    assert.deepEqual(candidate.linkedSourceIds, ["26-44956"])
    assert.deepEqual(candidate.departmentCodes, ["44"])
    assert.equal(candidate.publishedAt?.toISOString(), "2026-10-07T00:00:00.000Z")
    assert.equal(candidate.deadlineAt, null)
    assert.ok(candidate.descriptors.includes("Tente"))
    assert.equal(candidate.url, "https://www.boamp.fr/pages/avis/?q=idweb:26-96170")
  })

  it("appel d'offres réel → TENDER avec date limite ; département « 6 » normalisé en « 06 »", () => {
    const tender = mapBoampRecord(byId("26-100559"))
    assert.ok(tender)
    assert.equal(tender.kind, "TENDER")
    assert.equal(tender.noticeNature, "APPEL_OFFRE")
    assert.equal(tender.deadlineAt?.toISOString(), "2026-11-06T12:00:00.000Z")
    assert.deepEqual(tender.winners, [])

    const cannes = mapBoampRecord(byId("26-99849"))
    assert.deepEqual(cannes?.departmentCodes, ["06"])
    assert.ok(cannes?.winners.includes("HALL EXPO"))
  })

  it("enregistrement incomplet ou de forme inattendue → null ou valeurs vides, jamais d'exception", () => {
    assert.equal(mapBoampRecord({}), null)
    assert.equal(mapBoampRecord({ idweb: "26-1", objet: "   " }), null)
    const odd = mapBoampRecord({ idweb: "26-2", objet: "Location de chapiteaux", titulaire: "SOCIETE X", code_departement: [12, "ZZ", "2a"], datelimitereponse: "pas une date" })
    assert.ok(odd)
    assert.deepEqual(odd.winners, ["SOCIETE X"])
    assert.deepEqual(odd.departmentCodes, ["2A"])
    assert.equal(odd.deadlineAt, null)
  })

  it("entités HTML dans le nom de l'acheteur (avis réel « Mairie d&#039;ivry-sur-seine ») : décodées", () => {
    const candidate = mapBoampRecord({ idweb: "26-3", objet: "Location de chapiteaux", nomacheteur: "Mairie d&#039;ivry-sur-seine &amp; CCAS" })
    assert.equal(candidate?.organization, "Mairie d'ivry-sur-seine & CCAS")
  })

  it("normalizeDepartmentCode : métropole, Corse, outre-mer ; le reste est écarté", () => {
    assert.equal(normalizeDepartmentCode("6"), "06")
    assert.equal(normalizeDepartmentCode("75"), "75")
    assert.equal(normalizeDepartmentCode("2b"), "2B")
    assert.equal(normalizeDepartmentCode("974"), "974")
    assert.equal(normalizeDepartmentCode("123"), null)
    assert.equal(normalizeDepartmentCode("FR"), null)
  })
})

describe("requête BOAMP", () => {
  it("ne demande jamais les champs `donnees` ni `gestion` (identité des correspondants)", () => {
    const url = new URL(buildBoampRequestUrl(new Date("2026-11-01T06:00:00Z"), 0))
    const select: string[] = url.searchParams.get("select")?.split(",") ?? []
    assert.ok(!select.includes("donnees") && !select.includes("gestion"))
    assert.deepEqual(select, [...BOAMP_SELECTED_FIELDS])
    assert.equal(url.searchParams.get("limit"), "100")
  })

  it("clause ODSQL : date de parution, descripteurs et mots du métier", () => {
    const where = buildBoampWhereClause(new Date("2026-11-01T06:00:00Z"))
    assert.match(where, /^dateparution >= date'2026-11-01' AND \(/)
    assert.match(where, /descripteur_libelle="Tente"/)
    assert.match(where, /search\(objet,"chapiteau"\)/)
  })

  it("pagination : s'arrête sur une page incomplète ; erreur HTTP remontée sans détail sensible", async () => {
    const calls: string[] = []
    const page = (n: number) => Array.from({ length: n }, (_, i) => ({ idweb: `26-${calls.length}-${i}`, objet: "Location de chapiteaux" }))
    const fakeFetch = (async (url: string) => {
      calls.push(url)
      return new Response(JSON.stringify({ results: page(calls.length === 1 ? 100 : 7) }), { status: 200 })
    }) as unknown as typeof fetch
    const candidates = await fetchBoampCandidates({ now: new Date("2026-11-04T06:00:00Z"), lookbackDays: 3, fetchImpl: fakeFetch })
    assert.equal(calls.length, 2)
    assert.equal(candidates.length, 107)
    assert.match(calls[1], /offset=100/)
    assert.match(new URL(calls[0]).searchParams.get("where") ?? "", /^dateparution >= date'2026-11-01'/)

    const failing = (async () => new Response("", { status: 503 })) as unknown as typeof fetch
    await assert.rejects(fetchBoampCandidates({ now: new Date(), lookbackDays: 3, fetchImpl: failing }), /BOAMP_HTTP_503/)
  })
})
