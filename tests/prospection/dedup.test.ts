/** Veille prospection — dédoublonnage : même identifiant, même empreinte entre sources, attributions liées. */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { awardedToByTenderId, dedupeCandidates, fingerprintCandidate } from "@/lib/prospection/dedup"
import type { ProspectCandidate } from "@/lib/prospection/prospection.types"

function candidate(overrides: Partial<ProspectCandidate>): ProspectCandidate {
  return {
    source: "BOAMP", sourceId: "26-1", kind: "TENDER", title: "Location de chapiteaux", organization: "Ville de Test",
    departmentCodes: [], locality: null, publishedAt: null, deadlineAt: new Date("2026-12-01T12:00:00Z"), eventStartAt: null,
    eventPeriod: null, url: null, winners: [], linkedSourceIds: [], descriptors: [], noticeNature: "APPEL_OFFRE",
    reach: null, creationYear: null, ...overrides,
  }
}

describe("fingerprintCandidate", () => {
  it("insensible à la casse, aux accents, à la ponctuation et aux mots vides", () => {
    const a = candidate({ title: "Accord-cadre : LOCATION de chapiteaux et de tentes", organization: "Mairie d'Évry" })
    const b = candidate({ sourceId: "26-2", title: "accord cadre location chapiteaux tentes", organization: "MAIRIE D EVRY" })
    assert.equal(fingerprintCandidate(a), fingerprintCandidate(b))
  })

  it("la date limite distingue deux consultations du même acheteur", () => {
    const a = candidate({})
    const b = candidate({ sourceId: "26-2", deadlineAt: new Date("2027-03-01T12:00:00Z") })
    assert.notEqual(fingerprintCandidate(a), fingerprintCandidate(b))
  })

  it("événement : intitulé + commune", () => {
    const a = candidate({ kind: "EVENT", source: "FESTIVALS_CULTURE", title: "Festival des Vieilles Charrues", locality: "Carhaix-Plouguer" })
    assert.equal(fingerprintCandidate(a), "event|festival vieilles charrues|carhaix plouguer")
  })
})

describe("dedupeCandidates", () => {
  it("même source et même identifiant (recouvrement de deux collectes) : une seule fiche, listes complétées", () => {
    const result = dedupeCandidates([
      candidate({ departmentCodes: ["44"], descriptors: ["Tente"] }),
      candidate({ departmentCodes: ["85"], descriptors: ["Stand"], organization: null }),
    ])
    assert.equal(result.length, 1)
    assert.deepEqual(result[0].departmentCodes, ["44", "85"])
    assert.deepEqual(result[0].descriptors, ["Tente", "Stand"])
    assert.equal(result[0].organization, "Ville de Test")
  })

  it("même événement dans DATAtourisme et la liste des festivals : DATAtourisme l'emporte, l'autre est noté", () => {
    const result = dedupeCandidates([
      candidate({ source: "FESTIVALS_CULTURE", sourceId: "FEST_29024_1", kind: "EVENT", title: "Festival des Vieilles Charrues", locality: "Carhaix-Plouguer", url: "https://www.vieillescharrues.asso.fr/" }),
      candidate({ source: "DATATOURISME", sourceId: "https://data.datatourisme.fr/1/abc", kind: "EVENT", title: "Festival des Vieilles Charrues", locality: "Carhaix Plouguer", url: null }),
    ])
    assert.equal(result.length, 1)
    assert.equal(result[0].source, "DATATOURISME")
    assert.deepEqual(result[0].alsoSeenIn, ["FESTIVALS_CULTURE:FEST_29024_1"])
    assert.equal(result[0].url, "https://www.vieillescharrues.asso.fr/")
  })

  it("deux fiches distinctes d'une même source ne sont jamais fusionnées par l'empreinte", () => {
    const result = dedupeCandidates([candidate({ sourceId: "26-1" }), candidate({ sourceId: "26-2" })])
    assert.equal(result.length, 2)
  })

  it("une attribution et son appel d'offres restent deux fiches distinctes", () => {
    const result = dedupeCandidates([
      candidate({ sourceId: "26-44956" }),
      candidate({ sourceId: "26-96170", kind: "AWARD", deadlineAt: null, winners: ["PHIL EXPO"], linkedSourceIds: ["26-44956"] }),
    ])
    assert.equal(result.length, 2)
  })
})

describe("awardedToByTenderId", () => {
  it("relie chaque appel d'offres initial aux titulaires de ses attributions", () => {
    const map = awardedToByTenderId([
      candidate({ sourceId: "26-96170", kind: "AWARD", winners: ["PHIL EXPO", "SO BOYA"], linkedSourceIds: ["26-44956"] }),
      candidate({ sourceId: "26-96171", kind: "AWARD", winners: ["SO BOYA", "GL EVENT LIVE GRAND OUEST"], linkedSourceIds: ["26-44956"] }),
      candidate({ sourceId: "26-5", kind: "AWARD", winners: [], linkedSourceIds: ["26-4"] }),
    ])
    assert.deepEqual(map.get("26-44956"), ["PHIL EXPO", "SO BOYA", "GL EVENT LIVE GRAND OUEST"])
    assert.equal(map.has("26-4"), false)
  })
})
