/** SPEC-WORKSITE-PHOTOS-001 Lot 3 — helpers purs de compression côté client (sans canvas). */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { CLIENT_HARD_MAX_BYTES, COMPRESSION_FALLBACKS, planCompression, targetDimensions } from "@/lib/worksite-photos/client/compress-image"

describe("targetDimensions", () => {
  it("réduit proportionnellement au bord long, n'agrandit jamais, jamais 0 px", () => {
    assert.deepEqual(targetDimensions(4000, 3000, 2048), { width: 2048, height: 1536 })
    assert.deepEqual(targetDimensions(3000, 4000, 2048), { width: 1536, height: 2048 })
    assert.deepEqual(targetDimensions(1200, 800, 2048), { width: 1200, height: 800 }, "pas d'agrandissement")
    assert.deepEqual(targetDimensions(10000, 1, 2048), { width: 2048, height: 1 })
    assert.deepEqual(targetDimensions(0.4, 0.4, 2048), { width: 1, height: 1 })
    assert.deepEqual(targetDimensions(4001.9, 3000.2, 2048), { width: 2048, height: 1536 }, "dimensions non entières tronquées")
  })
})

describe("planCompression", () => {
  it("retient le premier palier sous la borne ; ignore une sortie vide ; null si aucun ne convient", () => {
    const attempts = COMPRESSION_FALLBACKS.map((f, i) => ({ ...f, resultBytes: [5_000_000, 3_500_000, 2_000_000][i] }))
    assert.deepEqual(planCompression(attempts, 3 * 1024 * 1024), { maxEdge: 1600, quality: 0.7 })
    assert.deepEqual(planCompression([{ maxEdge: 2048, quality: 0.82, resultBytes: 0 }, { maxEdge: 2048, quality: 0.7, resultBytes: 100 }], 1000), { maxEdge: 2048, quality: 0.7 })
    assert.equal(planCompression(attempts, 1_000_000), null)
    assert.equal(planCompression([], 1_000_000), null)
  })
  it("les paliers sont décroissants et la borne dure client vaut 4 Mio (alignée sur le serveur)", () => {
    for (let i = 1; i < COMPRESSION_FALLBACKS.length; i++) {
      const prev = COMPRESSION_FALLBACKS[i - 1], cur = COMPRESSION_FALLBACKS[i]
      assert.ok(cur.maxEdge < prev.maxEdge || cur.quality < prev.quality, `palier ${i} plus agressif que ${i - 1}`)
    }
    assert.equal(CLIENT_HARD_MAX_BYTES, 4 * 1024 * 1024)
  })
})
