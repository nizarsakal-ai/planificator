/** Plage partielle d'un bloc d'affectation : jours civils UTC, bornes incluses, refus des plages invalides. */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { validateBlockRange, ymdFr, ymdToUtc } from "@/lib/chantiers/assignment-range"

const BLOCK = { from: "2026-12-07", to: "2026-12-16" }

describe("plage dans un bloc d'affectation", () => {
  it("11→14 décembre dans le bloc 7→16 : 4 jours ; bloc entier : 10 jours ; un seul jour : 1", () => {
    assert.deepEqual(validateBlockRange(BLOCK, { from: "2026-12-11", to: "2026-12-14" }), { ok: true, from: "2026-12-11", to: "2026-12-14", days: 4 })
    assert.equal((validateBlockRange(BLOCK, BLOCK) as { days: number }).days, 10)
    assert.equal((validateBlockRange(BLOCK, { from: "2026-12-16", to: "2026-12-16" }) as { days: number }).days, 1)
    assert.equal(ymdFr("2026-12-11"), "11/12/2026")
  })
  it("refus : inversion, sortie du bloc, date impossible ou mal formée, bloc invalide", () => {
    for (const range of [
      { from: "2026-12-14", to: "2026-12-11" }, { from: "2026-12-06", to: "2026-12-10" }, { from: "2026-12-10", to: "2026-12-17" },
      { from: "2026-02-30", to: "2026-12-10" }, { from: "2026-12-1", to: "2026-12-10" }, { from: "", to: "2026-12-10" }, { from: "2026-12-11T00:00", to: "2026-12-14" },
    ]) assert.equal(validateBlockRange(BLOCK, range).ok, false)
    assert.equal(validateBlockRange({ from: "2026-12-16", to: "2026-12-07" }, { from: "2026-12-10", to: "2026-12-10" }).ok, false)
  })
  it("jours civils UTC : minuit UTC, indépendant du fuseau ; passage à l'heure d'été sans jour perdu", () => {
    assert.equal(ymdToUtc("2026-12-11"), Date.UTC(2026, 11, 11))
    assert.equal(ymdToUtc("2026-13-01"), null)
    assert.equal((validateBlockRange({ from: "2027-03-27", to: "2027-03-29" }, { from: "2027-03-27", to: "2027-03-29" }) as { days: number }).days, 3)
  })
})
