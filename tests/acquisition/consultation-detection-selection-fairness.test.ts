/**
 * PLAN-ACQ-DETECTION-001 — FIX 2 : équité de sélection Detection entre tenants.
 * SQL réel exercé en PG par consultation-detection-selection.integration.test.ts.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Prisma } from "@prisma/client"
import {
  AcquisitionConsultationDetectionSelectionRepository,
  type ConsultationDetectionCandidate,
  type ConsultationDetectionSelectionRepository,
} from "@/lib/acquisition/detection/consultation-detection.selection.repository"
import { runConsultationDetectionWorker } from "@/lib/acquisition/detection/consultation-detection.worker"

type CapturedQuery = { text: string; values: unknown[] }

/** Fake db : capture le SQL composé (fragments Prisma.sql inclus), retourne `rows`. */
function capturingDb(rows: unknown[] = []) {
  const queries: CapturedQuery[] = []
  const db = {
    queries,
    async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
      const sql = Prisma.sql(strings, ...values)
      queries.push({ text: sql.text.replace(/\s+/g, " ").trim(), values: sql.values })
      return rows
    },
  }
  return db
}

/** Critères d’éligibilité existants (inchangés par FIX 2). */
const ELIGIBILITY_FRAGMENTS = [
  `c."normalizedText" <> ''`,
  `d."detectionContentHash" IS NULL OR d."detectionContentHash" <> c."contentHash"`,
  `d."status" IN ( CAST('PENDING_EXTRACTION' AS "WorksiteImportDraftStatus"), CAST('FAILED' AS "WorksiteImportDraftStatus"), CAST('EXTRACTING' AS "WorksiteImportDraftStatus") )`,
  `ON c."acquisitionMessageId" = d."acquisitionMessageId" AND c."companyId" = d."companyId"`,
]

describe("FIX 2 — SQL sélection Detection (forme)", () => {
  it("tenants classés par ancienneté du candidat prioritaire, tie-break companyId, LIMIT borné", async () => {
    const db = capturingDb([])
    const repo = new AcquisitionConsultationDetectionSelectionRepository(db as never)
    await repo.listCompanyIdsNeedingDetection({ limit: 7.9 })
    const q = db.queries[0]!
    assert.match(q.text, /GROUP BY d\."companyId"/)
    assert.match(q.text, /ORDER BY MIN\(d\."updatedAt"\) ASC, d\."companyId" ASC LIMIT \$\d+/)
    // plus d’ordre purement lexicographique companyId
    assert.doesNotMatch(q.text, /ORDER BY d\."companyId" ASC LIMIT/)
    assert.deepEqual(q.values, [7])
  })

  it("F — critères d’éligibilité identiques dans les deux requêtes", async () => {
    const db = capturingDb([])
    const repo = new AcquisitionConsultationDetectionSelectionRepository(db as never)
    await repo.listCompanyIdsNeedingDetection({ limit: 20 })
    await repo.listCandidatesForCompany({ companyId: "co-a", limit: 5 })
    for (const q of db.queries) {
      for (const fragment of ELIGIBILITY_FRAGMENTS) {
        assert.ok(q.text.includes(fragment), `fragment absent : ${fragment}`)
      }
    }
  })

  it("D — companyId explicite : filtre strict paramétré, ordre interne updatedAt puis id", async () => {
    const db = capturingDb([])
    const repo = new AcquisitionConsultationDetectionSelectionRepository(db as never)
    await repo.listCandidatesForCompany({ companyId: "co-a", limit: 5 })
    const q = db.queries[0]!
    assert.match(q.text, /WHERE d\."companyId" = \$1 AND/)
    assert.equal(q.values[0], "co-a")
    assert.match(q.text, /ORDER BY d\."updatedAt" ASC, d\."id" ASC LIMIT \$\d+/)
    assert.equal(q.values.at(-1), 5)
  })

  it("D — companyId vide → aucune requête, aucun candidat", async () => {
    const db = capturingDb([])
    const repo = new AcquisitionConsultationDetectionSelectionRepository(db as never)
    const rows = await repo.listCandidatesForCompany({ companyId: "", limit: 5 })
    assert.deepEqual(rows, [])
    assert.equal(db.queries.length, 0)
  })

  it("D — lignes d’un autre tenant jamais retournées si la DB respecte le filtre (mapping fidèle)", async () => {
    const at = new Date("2026-09-01T00:00:00.000Z")
    const db = capturingDb([
      { id: "d1", companyId: "co-a", acquisitionMessageId: "m1", version: 1, createdAt: at, updatedAt: at },
    ])
    const repo = new AcquisitionConsultationDetectionSelectionRepository(db as never)
    const rows = await repo.listCandidatesForCompany({ companyId: "co-a", limit: 5 })
    assert.deepEqual(rows.map((r) => [r.draftId, r.companyId]), [["d1", "co-a"]])
  })
})

/**
 * Modèle en mémoire du contrat SQL (même ordre que le repository) pour tester
 * la composition worker : tenants par MIN(updatedAt) puis companyId ;
 * candidats par updatedAt puis id.
 */
type Seed = { draftId: string; companyId: string; updatedAt: string }

function contractSelection(seeds: Seed[]): ConsultationDetectionSelectionRepository {
  const rows: ConsultationDetectionCandidate[] = seeds.map((s) => ({
    draftId: s.draftId,
    companyId: s.companyId,
    acquisitionMessageId: `msg-${s.draftId}`,
    version: 1,
    createdAt: new Date(s.updatedAt),
    updatedAt: new Date(s.updatedAt),
  }))
  const byInternalOrder = (a: ConsultationDetectionCandidate, b: ConsultationDetectionCandidate) =>
    a.updatedAt.getTime() - b.updatedAt.getTime() || (a.draftId < b.draftId ? -1 : a.draftId > b.draftId ? 1 : 0)
  return {
    async listCompanyIdsNeedingDetection({ limit }) {
      const oldest = new Map<string, number>()
      for (const r of rows) {
        const t = r.updatedAt.getTime()
        if (!oldest.has(r.companyId) || t < oldest.get(r.companyId)!) oldest.set(r.companyId, t)
      }
      return [...oldest.entries()]
        .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .slice(0, limit)
        .map(([companyId]) => companyId)
    },
    async listCandidatesForCompany({ companyId, limit }) {
      return rows.filter((r) => r.companyId === companyId).sort(byInternalOrder).slice(0, limit)
    },
  }
}

async function runOrder(
  seeds: Seed[],
  opts: { maxCandidates: number; maxCompanies: number; maxPerCompany: number }
): Promise<Array<{ draftId: string; companyId: string }>> {
  const byMessage = new Map(seeds.map((s) => [`msg-${s.draftId}`, s]))
  const order: Array<{ draftId: string; companyId: string }> = []
  const result = await runConsultationDetectionWorker({
    selection: contractSelection(seeds),
    ...opts,
    log: () => {},
    detect: async ({ companyId, acquisitionMessageId }) => {
      const s = byMessage.get(acquisitionMessageId)!
      assert.equal(s.companyId, companyId)
      order.push({ draftId: s.draftId, companyId })
      return { persistOutcome: "PERSISTED" } as never
    },
  })
  assert.equal(result.status, "SUCCESS")
  return order
}

function day(n: number): string {
  return `2026-09-${String(n).padStart(2, "0")}T00:00:00.000Z`
}

describe("FIX 2 — équité worker Detection (contrat de sélection)", () => {
  it("A — chaque tenant obtient son 1er candidat avant tout 2e candidat", async () => {
    const seeds: Seed[] = []
    for (const [i, co] of ["co-a", "co-b", "co-c"].entries()) {
      for (let k = 0; k < 3; k++) {
        seeds.push({ draftId: `${co}-${k}`, companyId: co, updatedAt: day(1 + i + k * 3) })
      }
    }
    const order = await runOrder(seeds, { maxCandidates: 25, maxCompanies: 20, maxPerCompany: 5 })
    assert.equal(order.length, 9)
    const firstRound = order.slice(0, 3).map((o) => o.companyId)
    assert.deepEqual(new Set(firstRound), new Set(["co-a", "co-b", "co-c"]))
    assert.deepEqual(order.map((o) => o.draftId), [
      "co-a-0", "co-b-0", "co-c-0",
      "co-a-1", "co-b-1", "co-c-1",
      "co-a-2", "co-b-2", "co-c-2",
    ])
  })

  it("B — plus de tenants que le batch : borné, ordre déterministe (ancienneté puis companyId)", async () => {
    const seeds: Seed[] = []
    for (let i = 1; i <= 30; i++) {
      const co = `t${String(i).padStart(2, "0")}`
      // t26 le plus ancien ; t27/t28 ex æquo → tie-break companyId
      const updatedAt =
        i === 26 ? "2026-01-01T00:00:00.000Z"
        : i === 27 || i === 28 ? "2026-01-02T00:00:00.000Z"
        : `2026-02-01T00:00:${String(i).padStart(2, "0")}.000Z`
      seeds.push({ draftId: `d-${co}`, companyId: co, updatedAt })
    }
    const opts = { maxCandidates: 10, maxCompanies: 20, maxPerCompany: 5 }
    const order = await runOrder(seeds, opts)
    assert.equal(order.length, 10)
    assert.deepEqual(order.slice(0, 3).map((o) => o.companyId), ["t26", "t27", "t28"])
    // tenant au-delà de la limite lexicographique (t26) n’est plus masqué
    assert.ok(order.some((o) => o.companyId === "t26"))
    const again = await runOrder(seeds, opts)
    assert.deepEqual(again, order)
  })

  it("C — un tenant avec beaucoup de drafts plus anciens ne monopolise pas le batch", async () => {
    const seeds: Seed[] = []
    for (let k = 0; k < 40; k++) {
      seeds.push({
        draftId: `big-${String(k).padStart(2, "0")}`,
        companyId: "co-big",
        updatedAt: `2026-01-01T00:${String(k).padStart(2, "0")}:00.000Z`,
      })
    }
    for (const co of ["co-x", "co-y", "co-z"]) {
      seeds.push({ draftId: `${co}-0`, companyId: co, updatedAt: "2026-06-01T00:00:00.000Z" })
    }
    const order = await runOrder(seeds, { maxCandidates: 6, maxCompanies: 20, maxPerCompany: 5 })
    assert.equal(order.length, 6)
    const big = order.filter((o) => o.companyId === "co-big").length
    assert.ok(big <= 3, `co-big a pris ${big} places sur 6`)
    for (const co of ["co-x", "co-y", "co-z"]) {
      assert.ok(order.some((o) => o.companyId === co), `${co} affamé`)
    }
    assert.deepEqual(order.slice(0, 4).map((o) => o.companyId), ["co-big", "co-x", "co-y", "co-z"])
  })

  it("E — même tenant : ordre interne déterministe updatedAt puis id (tie-break)", async () => {
    const seeds: Seed[] = [
      { draftId: "d-c", companyId: "co-a", updatedAt: day(2) },
      { draftId: "d-b", companyId: "co-a", updatedAt: day(1) },
      { draftId: "d-a", companyId: "co-a", updatedAt: day(2) },
    ]
    const order = await runOrder(seeds, { maxCandidates: 25, maxCompanies: 20, maxPerCompany: 5 })
    assert.deepEqual(order.map((o) => o.draftId), ["d-b", "d-a", "d-c"])
  })
})
