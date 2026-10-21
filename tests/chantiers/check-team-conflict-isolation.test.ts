/**
 * Ticket #77 — checkTeamConflict : isolation par entreprise (aucune DB).
 * Quatre cas exigés : (1) même entreprise ⇒ conflit ; (2) teamId d'une autre entreprise ⇒ null ;
 * (3) session sans companyId ⇒ null, aucune requête ; (4) affectation incohérente (équipe de A,
 * chantier de B) ⇒ null pour les deux sessions.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  buildTeamConflictWhere,
  checkTeamConflictCore,
  type TeamConflictHit,
  type TeamConflictQuery,
  type TeamConflictSession,
} from "@/lib/actions/assignment-team-conflict.core"

// ---- Jeu de données en mémoire (deux entreprises) ---------------------------------------------

type Row = {
  teamId: string
  teamCompanyId: string
  worksiteId: string
  worksiteCompanyId: string
  worksiteName: string
  date: string
}

const DAY = "2026-10-21"
const ROWS: Row[] = [
  // Entreprise A : équipe A1 affectée au chantier WA1
  { teamId: "teamA1", teamCompanyId: "A", worksiteId: "wsA1", worksiteCompanyId: "A", worksiteName: "Chantier A1", date: DAY },
  // Entreprise B : équipe B1 affectée au chantier WB1
  { teamId: "teamB1", teamCompanyId: "B", worksiteId: "wsB1", worksiteCompanyId: "B", worksiteName: "Chantier B1", date: DAY },
  // Incohérente : équipe de A affectée à un chantier de B (donnée corrompue ou attaque)
  { teamId: "teamAX", teamCompanyId: "A", worksiteId: "wsBX", worksiteCompanyId: "B", worksiteName: "Chantier B secret", date: DAY },
  // Incohérente inverse : équipe de B affectée à un chantier de A
  { teamId: "teamBY", teamCompanyId: "B", worksiteId: "wsAY", worksiteCompanyId: "A", worksiteName: "Chantier A exposé", date: DAY },
]

/**
 * Évalue la clause `where` produite par le cœur avec la sémantique Prisma des champs utilisés
 * (égalité scalaire, relation to-one `{ companyId }`, `worksiteId: { not }`). Si le cœur omettait
 * l'un des deux filtres d'entreprise, ce simulateur le laisserait passer : c'est ce que les cas
 * (2) et (4) vérifient.
 */
function findFirstInMemory(query: TeamConflictQuery): TeamConflictHit {
  const where = buildTeamConflictWhere(query)
  const hit = ROWS.find((r) => {
    if (where.teamId !== undefined && r.teamId !== where.teamId) return false
    if (where.date instanceof Date && new Date(r.date).getTime() !== where.date.getTime()) return false
    const teamFilter = where.team as { companyId?: string } | undefined
    if (teamFilter?.companyId !== undefined && r.teamCompanyId !== teamFilter.companyId) return false
    const wsFilter = where.worksite as { companyId?: string } | undefined
    if (wsFilter?.companyId !== undefined && r.worksiteCompanyId !== wsFilter.companyId) return false
    const notWs = (where.worksiteId as { not?: string } | undefined)?.not
    if (notWs !== undefined && r.worksiteId === notWs) return false
    return true
  })
  return hit ? { worksiteName: hit.worksiteName } : null
}

function sessionFor(companyId: string | null | undefined): () => Promise<TeamConflictSession> {
  return async () => ({ user: { id: `user-${companyId ?? "none"}`, companyId } })
}

function harness(companyId: string | null | undefined) {
  const queries: TeamConflictQuery[] = []
  const deps = {
    auth: sessionFor(companyId),
    findConflict: async (q: TeamConflictQuery) => {
      queries.push(q)
      return findFirstInMemory(q)
    },
  }
  return { deps, queries }
}

// ---- Tests ----------------------------------------------------------------------------------

describe("#77 — checkTeamConflict : isolation par entreprise", () => {
  it("(1) même entreprise ⇒ le conflit est renvoyé", async () => {
    const h = harness("A")
    const r = await checkTeamConflictCore("teamA1", DAY, undefined, h.deps)
    assert.deepEqual(r, { worksiteName: "Chantier A1" })
    assert.equal(h.queries.length, 1)
    assert.equal(h.queries[0].companyId, "A")
  })

  it("(2) teamId d'une autre entreprise ⇒ null (aucune fuite du nom de chantier)", async () => {
    const h = harness("A")
    const r = await checkTeamConflictCore("teamB1", DAY, undefined, h.deps)
    assert.equal(r, null)
    assert.equal(h.queries.length, 1, "la requête est bien bornée à l'entreprise A, pas absente")
  })

  it("(3) session sans companyId ⇒ null et AUCUNE requête", async () => {
    for (const missing of [null, undefined, ""] as const) {
      const h = harness(missing)
      const r = await checkTeamConflictCore("teamA1", DAY, undefined, h.deps)
      assert.equal(r, null)
      assert.equal(h.queries.length, 0, `companyId=${String(missing)} : aucune requête attendue`)
    }
  })

  it("(3bis) session absente ⇒ null et aucune requête", async () => {
    const queries: TeamConflictQuery[] = []
    const r = await checkTeamConflictCore("teamA1", DAY, undefined, {
      auth: async () => null,
      findConflict: async (q) => { queries.push(q); return findFirstInMemory(q) },
    })
    assert.equal(r, null)
    assert.equal(queries.length, 0)
  })

  it("(4) affectation incohérente (équipe de A, chantier de B, et l'inverse) ⇒ null pour A ET pour B", async () => {
    for (const teamId of ["teamAX", "teamBY"]) {
      const a = await checkTeamConflictCore(teamId, DAY, undefined, harness("A").deps)
      const b = await checkTeamConflictCore(teamId, DAY, undefined, harness("B").deps)
      assert.equal(a, null, `${teamId} : A ne doit rien voir`)
      assert.equal(b, null, `${teamId} : B ne doit rien voir`)
    }
  })

  it("excludeWorksiteId reste appliqué à l'intérieur du périmètre de l'entreprise", async () => {
    const h = harness("A")
    const r = await checkTeamConflictCore("teamA1", DAY, "wsA1", h.deps)
    assert.equal(r, null)
    assert.equal(h.queries[0].excludeWorksiteId, "wsA1")
  })

  it("la clause where porte toujours les deux filtres d'entreprise, avec ou sans exclusion", () => {
    for (const excludeWorksiteId of [undefined, "wsX"]) {
      const where = buildTeamConflictWhere({ companyId: "A", teamId: "t", date: new Date(DAY), excludeWorksiteId })
      assert.deepEqual(where.team, { companyId: "A" })
      assert.deepEqual(where.worksite, { companyId: "A" })
      assert.equal(where.teamId, "t")
      if (excludeWorksiteId) assert.deepEqual(where.worksiteId, { not: "wsX" })
      else assert.equal(where.worksiteId, undefined)
    }
  })

  it("preuve de discrimination : retirer l'un des deux filtres fait fuir une ligne incohérente", () => {
    type W = ReturnType<typeof buildTeamConflictWhere>
    const evaluate = (w: W) => {
      const teamCo = (w.team as { companyId?: string } | undefined)?.companyId
      const wsCo = (w.worksite as { companyId?: string } | undefined)?.companyId
      return ROWS.find((r) => r.teamId === w.teamId
        && (teamCo === undefined || r.teamCompanyId === teamCo)
        && (wsCo === undefined || r.worksiteCompanyId === wsCo))
    }
    // Session A interroge teamAX (équipe A → chantier B)
    const wAX = buildTeamConflictWhere({ companyId: "A", teamId: "teamAX", date: new Date(DAY) })
    assert.equal(evaluate(wAX), undefined, "les deux filtres : rien")
    assert.equal(evaluate({ ...wAX, worksite: undefined })?.worksiteName, "Chantier B secret", "sans filtre chantier : fuite")
    // Session A interroge teamBY (équipe B → chantier A)
    const wBY = buildTeamConflictWhere({ companyId: "A", teamId: "teamBY", date: new Date(DAY) })
    assert.equal(evaluate(wBY), undefined, "les deux filtres : rien")
    assert.equal(evaluate({ ...wBY, team: undefined })?.worksiteName, "Chantier A exposé", "sans filtre équipe : fuite du planning d'une équipe de B")
  })
})
