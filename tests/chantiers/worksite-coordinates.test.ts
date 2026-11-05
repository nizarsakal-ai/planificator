/** Coordonnées manuelles d'un chantier : mode explicite, paire validée, aucun géocodage en mode manuel. Données fictives. */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { readManualCoordinates, resolveWorksiteCoordinates, type ManualCoordinates } from "@/lib/chantiers/worksite-coordinates"

const form = (fields: Record<string, string | string[]>) => {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) fd.append(k, x)
  return fd
}
const manual = (latitude: string, longitude: string) => form({ coordinatesMode: "manual", latitude, longitude })

describe("coordonnées manuelles : lecture du formulaire", () => {
  it("case non cochée : absent, champs éventuels ignorés (comportement historique)", () => {
    assert.deepEqual(readManualCoordinates(form({})), { kind: "absent" })
    assert.deepEqual(readManualCoordinates(form({ latitude: "48.8", longitude: "2.3" })), { kind: "absent" })
  })
  it("paire valide, point ou virgule ; bornes incluses ; zéro sur un seul axe admis", () => {
    assert.deepEqual(readManualCoordinates(manual("47,5", "-1,75")), { kind: "manual", latitude: 47.5, longitude: -1.75 })
    assert.deepEqual(readManualCoordinates(manual("-90", "180")), { kind: "manual", latitude: -90, longitude: 180 })
    assert.deepEqual(readManualCoordinates(manual("0", "-1.5")), { kind: "manual", latitude: 0, longitude: -1.5 })
  })
  it("refus : paire incomplète, vide, non numérique, NaN, Infinity, exposant, hors bornes, (0, 0), mode ou champ répété", () => {
    const bad: FormData[] = [
      form({ coordinatesMode: "manual", latitude: "48.8" }), manual("", "2.3"), manual("48.8", " "), manual("abc", "2.3"),
      manual("NaN", "2.3"), manual("48.8", "Infinity"), manual("4e1", "2.3"), manual("90.01", "2"), manual("45", "-180.5"),
      manual("0", "0"), form({ coordinatesMode: "auto", latitude: "48.8", longitude: "2.3" }),
      form({ coordinatesMode: ["manual", "manual"], latitude: "48.8", longitude: "2.3" }), form({ coordinatesMode: "manual", latitude: ["48.8", "48.9"], longitude: "2.3" }),
    ]
    for (const fd of bad) assert.equal(readManualCoordinates(fd).kind, "invalid")
  })
})

describe("coordonnées à enregistrer", () => {
  const current = { latitude: 1, longitude: 2 }
  const run = async (manualValue: ManualCoordinates, previousAddress: string | null, nextAddress: string | undefined, found: { latitude: number; longitude: number } | null) => {
    const calls: string[] = []
    const result = await resolveWorksiteCoordinates({ manual: manualValue, current, previousAddress, nextAddress, geocode: async (a) => { calls.push(a); return found } })
    return { result, calls }
  }
  it("mode manuel : coordonnées saisies, aucun géocodage même si l'adresse change", async () => {
    const r = await run({ kind: "manual", latitude: 47.5, longitude: -1.75 }, "A", "B", { latitude: 9, longitude: 9 })
    assert.deepEqual([r.result, r.calls], [{ latitude: 47.5, longitude: -1.75 }, []])
  })
  it("hors mode : géocodage seulement si l'adresse change ; échec → coordonnées conservées", async () => {
    assert.deepEqual(await run({ kind: "absent" }, "A", "A", { latitude: 9, longitude: 9 }), { result: current, calls: [] })
    assert.deepEqual(await run({ kind: "absent" }, "A", "B", { latitude: 9, longitude: 8 }), { result: { latitude: 9, longitude: 8 }, calls: ["B"] })
    assert.deepEqual(await run({ kind: "absent" }, "A", "B", null), { result: current, calls: ["B"] })
    assert.deepEqual(await run({ kind: "absent" }, "A", "", { latitude: 9, longitude: 9 }), { result: current, calls: [] })
  })
})
