/** Veille prospection — service de collecte (dépôt factice) et handler du cron (auth, drapeau, société). */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { ProspectionRepositoryPort } from "@/lib/prospection/prospection.repository"
import type { ProspectCandidate, ScoredCandidate } from "@/lib/prospection/prospection.types"
import { runProspectionWatch, type ProspectionWatchDeps } from "@/lib/prospection/prospection-watch.service"
import { handleProspectionWatchCron } from "@/lib/prospection/prospection-cron.handler"

const TUESDAY = new Date("2026-11-03T06:00:00Z")
const MONDAY = new Date("2026-11-02T06:00:00Z")

function boampTender(id: string, title = "Location et montage de chapiteaux"): ProspectCandidate {
  return {
    source: "BOAMP", sourceId: id, kind: "TENDER", title, organization: "Ville", departmentCodes: ["44"], locality: null,
    publishedAt: TUESDAY, deadlineAt: new Date("2026-12-01T12:00:00Z"), eventStartAt: null, eventPeriod: null, url: null,
    winners: [], linkedSourceIds: [], descriptors: [], noticeNature: "APPEL_OFFRE", reach: null, creationYear: null,
  }
}

function festival(id: string, reach: string | null): ProspectCandidate {
  return {
    source: "FESTIVALS_CULTURE", sourceId: id, kind: "EVENT", title: `Festival ${id}`, organization: null, departmentCodes: ["29"],
    locality: `Commune ${id}`, publishedAt: null, deadlineAt: null, eventStartAt: null, eventPeriod: "Saison (21 juin - 5 septembre)",
    url: null, winners: [], linkedSourceIds: [], descriptors: reach ? ["Musique"] : ["Livre"], noticeNature: null, reach, creationYear: reach ? 1990 : 2024,
  }
}

function fakeRepository(festivalCount = 10) {
  const stored: Array<{ companyId: string; candidates: readonly ScoredCandidate[] }> = []
  const repository: ProspectionRepositoryPort = {
    async upsertCandidates(companyId, candidates) {
      stored.push({ companyId, candidates })
      return { created: candidates.length, updated: 0, unchanged: 0 }
    },
    async applyAwards() {
      return 0
    },
    async countBySource() {
      return festivalCount
    },
  }
  return { repository, stored }
}

function deps(overrides: Partial<ProspectionWatchDeps>): ProspectionWatchDeps {
  return {
    companyIds: ["company-galya"],
    now: TUESDAY,
    repository: fakeRepository().repository,
    fetchBoamp: async () => [boampTender("26-1")],
    fetchFestivals: async () => [festival("A", "Nationale"), festival("B", null)],
    fetchDatatourisme: null,
    ...overrides,
  }
}

describe("runProspectionWatch", () => {
  it("mardi avec des festivals déjà en base : seul le BOAMP est relu ; DATAtourisme désactivé", async () => {
    const { repository, stored } = fakeRepository(10)
    let festivalsRead = false
    const result = await runProspectionWatch(deps({ repository, fetchFestivals: async () => { festivalsRead = true; return [] } }))
    assert.equal(festivalsRead, false)
    assert.deepEqual(result.sources.map((s) => [s.source, s.status]), [["BOAMP", "OK"], ["FESTIVALS_CULTURE", "NOT_DUE"], ["DATATOURISME", "DISABLED"]])
    assert.equal(stored[0].candidates.length, 1)
  })

  it("lundi, ou aucune fiche festival en base : la liste des festivals est relue ; festivals masqués non enregistrés", async () => {
    for (const [now, count] of [[MONDAY, 10], [TUESDAY, 0]] as const) {
      const { repository, stored } = fakeRepository(count)
      const result = await runProspectionWatch(deps({ now, repository }))
      assert.equal(result.sources[1].status, "OK")
      const ids = stored[0].candidates.map((c) => c.sourceId).sort()
      assert.deepEqual(ids, ["26-1", "A"], "le festival B (masqué) n'est pas enregistré")
    }
  })

  it("une source en échec n'empêche pas les autres", async () => {
    const { repository, stored } = fakeRepository(0)
    const result = await runProspectionWatch(deps({ repository, fetchBoamp: async () => { throw new Error("BOAMP_HTTP_503") } }))
    assert.deepEqual(result.sources[0], { source: "BOAMP", status: "FAILED", fetched: 0, error: "BOAMP_HTTP_503" })
    assert.deepEqual(stored[0].candidates.map((c) => c.sourceId), ["A"])
  })

  it("chaque société configurée reçoit le même lot ; aucune société → rien n'est fait", async () => {
    const { repository, stored } = fakeRepository()
    await runProspectionWatch(deps({ repository, companyIds: ["c1", "c2"] }))
    assert.deepEqual(stored.map((s) => s.companyId), ["c1", "c2"])

    let fetched = false
    const empty = await runProspectionWatch(deps({ companyIds: [], fetchBoamp: async () => { fetched = true; return [] } }))
    assert.deepEqual(empty, { sources: [], companies: [] })
    assert.equal(fetched, false)
  })

  it("les fiches enregistrées portent score, bande, raisons et empreinte", async () => {
    const { repository, stored } = fakeRepository()
    await runProspectionWatch(deps({ repository }))
    const [tender] = stored[0].candidates
    assert.equal(tender.band, "A_TRAITER")
    assert.ok(tender.reasons.length > 0)
    assert.match(tender.fingerprint, /^tender\|ville\|/)
  })
})

describe("handleProspectionWatchCron", () => {
  const authorized = () => new Request("https://x/api/cron/prospection-veille", { headers: { authorization: "Bearer s3cret" } })
  const withSecret = async <T>(fn: () => Promise<T>) => {
    const previous = process.env.CRON_SECRET
    process.env.CRON_SECRET = "s3cret"
    try {
      return await fn()
    } finally {
      if (previous === undefined) delete process.env.CRON_SECRET
      else process.env.CRON_SECRET = previous
    }
  }

  it("sans jeton : 401, avant toute lecture du drapeau", async () => {
    await withSecret(async () => {
      const response = await handleProspectionWatchCron(new Request("https://x/api/cron/prospection-veille"), { env: { PROSPECTION_WATCH_ENABLED: "true" } })
      assert.equal(response.status, 401)
    })
  })

  it("drapeau absent ou mal orthographié : 200 « skipped », aucune collecte", async () => {
    await withSecret(async () => {
      for (const value of [undefined, "TRUE", "1", " true"]) {
        let built = false
        const response = await handleProspectionWatchCron(authorized(), {
          env: { PROSPECTION_WATCH_ENABLED: value },
          buildDeps: () => { built = true; return deps({}) },
        })
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { status: "skipped", reason: "PROSPECTION_WATCH_DISABLED" })
        assert.equal(built, false)
      }
    })
  })

  it("drapeau actif sans société configurée : « skipped » ; avec société : collecte exécutée", async () => {
    await withSecret(async () => {
      const none = await handleProspectionWatchCron(authorized(), { env: { PROSPECTION_WATCH_ENABLED: "true" }, buildDeps: () => deps({ companyIds: [] }) })
      assert.deepEqual(await none.json(), { status: "skipped", reason: "NO_COMPANY_CONFIGURED" })

      const { repository, stored } = fakeRepository()
      const ok = await handleProspectionWatchCron(authorized(), { env: { PROSPECTION_WATCH_ENABLED: "true" }, buildDeps: () => deps({ repository }) })
      assert.equal(ok.status, 200)
      const body = await ok.json()
      assert.equal(body.status, "ok")
      assert.equal(stored.length, 1)
    })
  })
})
