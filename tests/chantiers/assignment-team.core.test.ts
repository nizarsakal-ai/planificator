/**
 * LOT-1W-1a — T-CORE-2 (assignTeamCore), T-CORE-3 (adaptateur affecterEquipe), T-CORE-6
 * (non-durcissement), T-CORE-7 (fuseau).
 *
 * 1. Parité : chaque cas `affecterEquipe` du harnais est rejoué contre adaptateur + cœur avec les
 *    MÊMES doubles, la MÊME horloge figée et le MÊME `TZ` que la référence BASE_SHA, puis comparé
 *    par égalité profonde (retour, trace ordonnée avec le marqueur `inTx`, e-mail, revalidation,
 *    `console.error`). Références jamais régénérées : toute divergence = défaut du refactor.
 * 2. T-CORE-6 : le `where` du conflit équipe est documenté TEL QU'OBSERVÉ sur BASE_SHA (sans
 *    `team.companyId`) — le filtre d'entreprise relève de 1W-1b (T-HARD-1) ; ce test n'impose jamais
 *    de le retirer : il reflète la référence.
 * 3. Cœur seul : contrat `CoreResult` (codes, `details.message`, `data`), frontière transactionnelle.
 *
 * Exécution : `TZ=<UTC|Europe/Paris> node --import tsx --experimental-test-module-mocks --test <fichier>`.
 */

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { before, describe, it } from "node:test"
import {
  CASES,
  REFERENCE_DIR,
  SUPPORTED_TZ,
  loadActions,
  referenceFileName,
  runCase,
  stableJson,
  type ActionsModule,
  type CaseRecord,
  type TraceEntry,
} from "./parity/harness"
import {
  assignTeamCore,
  type AssignTeamDeps,
  type AssignTeamInput,
  type AssignTeamTx,
} from "@/lib/actions/assignment-team.core"

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()
const TZ = process.env.TZ ?? ""

function readReference(caseId: string): CaseRecord {
  const path = join(ROOT, REFERENCE_DIR, referenceFileName(caseId, TZ))
  assert.ok(existsSync(path), `référence absente : ${path}`)
  return JSON.parse(readFileSync(path, "utf8")) as CaseRecord
}

type PrismaEntry = Extract<TraceEntry, { kind: "prisma" }>
function prismaEntries(trace: TraceEntry[]): PrismaEntry[] {
  return trace.filter((t): t is PrismaEntry => t.kind === "prisma")
}

// ---- 1. Parité contre la référence BASE_SHA -------------------------------------------------------

describe(`T-CORE-2/T-CORE-3 — parité affecterEquipe (adaptateur + cœur) vs référence BASE_SHA [TZ=${TZ || "non défini"}]`, () => {
  let actions: ActionsModule
  before(async () => {
    assert.ok(SUPPORTED_TZ[TZ], `TZ doit valoir ${Object.keys(SUPPORTED_TZ).join(" ou ")} (reçu ${JSON.stringify(TZ)})`)
    assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, TZ, "fuseau effectif ≠ TZ")
    actions = await loadActions()
  })

  const assignCases = CASES.filter((c) => c.action === "affecterEquipe")
  assert.ok(assignCases.length >= 30, "jeu de cas affecterEquipe incomplet")

  for (const c of assignCases) {
    it(`${c.id} — ${c.title}`, async () => {
      const reference = readReference(c.id)
      const replay = JSON.parse(stableJson(await runCase(actions, c))) as CaseRecord
      assert.deepEqual(replay.input, reference.input, "entrées du cas ≠ référence (définition du cas modifiée ?)")
      assert.deepEqual(replay.result, reference.result, "retour ≠ référence BASE_SHA")
      assert.deepEqual(replay.trace, reference.trace, "trace (appels, args, inTx, effets) ≠ référence BASE_SHA")
    })
  }

  it("T-CORE-3 (4bis) : session absente / EMPLOYEE / sans companyId ⇒ même exception, aucun appel Prisma, aucun effet (lu dans la référence)", () => {
    const expected: Record<string, string> = {
      "assign-auth-session-absent": "Non authentifié",
      "assign-auth-role-employee": "Accès refusé",
      "assign-auth-no-company": "Entreprise introuvable",
    }
    for (const [id, message] of Object.entries(expected)) {
      const ref = readReference(id)
      assert.deepEqual(ref.result, { threw: { name: "Error", message } })
      assert.deepEqual(ref.trace.map((t) => t.kind), ["auth"])
    }
  })

  it("T-CORE-3 (frontière transactionnelle) : créations, mise à jour, notification, lectures du chef/entreprise et e-mail DANS la transaction ; revalidations après commit (lu dans la référence)", () => {
    const ref = readReference("assign-multi-day")
    const kinds = ref.trace.map((t) => (t.kind === "tx" ? `tx:${t.event}` : t.kind === "prisma" ? `${t.model}.${t.method}@${t.inTx ? "tx" : "root"}` : t.kind))
    assert.deepEqual(kinds, [
      "auth",
      "worksite.findFirst@root",
      "team.findFirst@root",
      "assignment.findFirst@root",
      "employeeAssignment.findMany@root",
      "tx:begin",
      "assignment.create@tx", "employeeAssignment.createMany@tx",
      "assignment.create@tx", "employeeAssignment.createMany@tx",
      "assignment.create@tx", "employeeAssignment.createMany@tx",
      "worksite.update@tx",
      "notification.create@tx",
      "user.findUnique@tx",
      "company.findUnique@tx",
      "email",
      "tx:commit",
      "revalidatePath", "revalidatePath", "revalidatePath",
    ])
  })

  it("T-CORE-3 (échec de transaction) : rollback simulé ⇒ console.error [affecterEquipe], message générique, aucune revalidation ni e-mail (lu dans la référence)", () => {
    for (const id of ["assign-tx-error-assignment-create", "assign-tx-error-notification-create", "assign-tx-error-non-error-value"]) {
      const ref = readReference(id)
      assert.deepEqual(ref.result, { returned: { error: "Erreur lors de la création des affectations. Veuillez réessayer." } })
      const kinds = ref.trace.map((t) => t.kind)
      assert.ok(ref.trace.some((t) => t.kind === "tx" && t.event === "rollback"), `${id} : rollback absent`)
      assert.ok(!kinds.includes("revalidatePath"), `${id} : revalidation après échec`)
      assert.ok(!kinds.includes("email"), `${id} : e-mail après échec`)
      const log = ref.trace.find((t) => t.kind === "console.error")
      assert.ok(log && log.kind === "console.error" && log.args[0] === "[affecterEquipe] transaction error:", `${id} : console.error attendu`)
    }
  })
})

// ---- 2. T-CORE-6 : preuve de non-durcissement -----------------------------------------------------

describe("T-CORE-6 — where du conflit équipe tel qu'observé sur BASE_SHA (filtre d'entreprise : 1W-1b, T-HARD-1)", () => {
  it("référence BASE_SHA : { teamId, date: { in } } — aucune clé team.companyId", () => {
    const ref = readReference("assign-team-conflict-with-address")
    const hit = prismaEntries(ref.trace).find((t) => t.model === "assignment" && t.method === "findFirst")
    assert.ok(hit, "requête de conflit équipe absente de la référence")
    const args = hit.args as { where: Record<string, unknown> }
    assert.deepEqual(Object.keys(args.where), ["teamId", "date"])
    assert.equal("team" in args.where, false, "à BASE_SHA le conflit équipe n'est pas filtré par entreprise (durcissement 1W-1b)")
  })

  it("cœur refactoré : même where, mêmes clés, même absence de filtre (parité, pas correction)", async () => {
    const { deps, calls } = fakeDeps({ teamConflict: { date: new Date("2026-11-04T00:00:00.000Z"), worksite: { name: "Chantier Bêta", address: null } } })
    const r = await assignTeamCore(INPUT, ACTOR, deps)
    assert.equal(r.ok, false)
    const conflict = calls.find((c) => c.port === "findTeamConflict")
    assert.ok(conflict)
    const args = conflict.args as { where: Record<string, unknown>; include: unknown; orderBy: unknown }
    assert.deepEqual(Object.keys(args.where), ["teamId", "date"])
    assert.deepEqual(args.include, { worksite: { select: { name: true, address: true } } })
    assert.deepEqual(args.orderBy, { date: "asc" })
  })
})

// ---- 3. Cœur seul ----------------------------------------------------------------------------------

type Call = { port: string; args: unknown; inTx: boolean }

type FakeOptions = Partial<{
  worksite: { id: string; name: string; status: "PLANNED" | "IN_PROGRESS" } | null
  team: { members: { employeeId: string }[]; leader: { userId: string | null } | null } | null
  teamConflict: { date: Date; worksite: { name: string; address: string | null } } | null
  employeeConflicts: { date: Date; employee: { firstName: string; lastName: string }; assignment: { worksite: { name: string }; team: { name: string } } }[]
  leaderUser: { email: string | null; name: string | null } | null
  failAt: "assignment.create" | "notification.create"
}>

function fakeDeps(over: FakeOptions = {}) {
  const calls: Call[] = []
  const emails: unknown[] = []
  let n = 0
  const tx: AssignTeamTx = {
    assignment: {
      create: async (args) => {
        calls.push({ port: "assignment.create", args, inTx: true })
        if (over.failAt === "assignment.create") throw new Error("P2002")
        n += 1
        return { id: `assignment-${n}` }
      },
    },
    employeeAssignment: { createMany: async (args) => { calls.push({ port: "employeeAssignment.createMany", args, inTx: true }); return { count: args.data.length } } },
    worksite: { update: async (args) => { calls.push({ port: "worksite.update", args, inTx: true }); return {} } },
    notification: {
      create: async (args) => {
        calls.push({ port: "notification.create", args, inTx: true })
        if (over.failAt === "notification.create") throw new Error("notification failed")
        return {}
      },
    },
    user: { findUnique: async (args) => { calls.push({ port: "user.findUnique", args, inTx: true }); return over.leaderUser === undefined ? { email: "chef@example.test", name: "Chef" } : over.leaderUser } },
    company: { findUnique: async (args) => { calls.push({ port: "company.findUnique", args, inTx: true }); return { name: "Entreprise A" } } },
  }
  const deps: AssignTeamDeps = {
    findWorksite: async (args) => { calls.push({ port: "findWorksite", args, inTx: false }); return over.worksite === undefined ? { id: "worksite-1", name: "Chantier Alpha", status: "PLANNED" } : over.worksite },
    findTeam: async (args) => { calls.push({ port: "findTeam", args, inTx: false }); return over.team === undefined ? { members: [{ employeeId: "employee-1" }, { employeeId: "employee-2" }], leader: { userId: "user-leader-1" } } : over.team },
    findTeamConflict: async (args) => { calls.push({ port: "findTeamConflict", args, inTx: false }); return over.teamConflict ?? null },
    findEmployeeConflicts: async (args) => { calls.push({ port: "findEmployeeConflicts", args, inTx: false }); return over.employeeConflicts ?? [] },
    transaction: async (fn) => {
      calls.push({ port: "$transaction:begin", args: null, inTx: false })
      try {
        const r = await fn(tx)
        calls.push({ port: "$transaction:commit", args: null, inTx: false })
        return r
      } catch (err) {
        calls.push({ port: "$transaction:rollback", args: null, inTx: false })
        throw err
      }
    },
    sendAssignmentCreatedEmail: async (args) => { emails.push(args) },
  }
  return { deps, calls, emails }
}

const ACTOR = { companyId: "company-A", actorUserId: "user-admin-1" }
const INPUT: AssignTeamInput = { worksiteId: "worksite-1", teamId: "team-1", dateFrom: "2026-11-03", dateTo: "2026-11-05" }

describe("T-CORE-2 — assignTeamCore (cœur seul, dépendances en mémoire)", () => {
  it("champs manquants ⇒ VALIDATION « Informations manquantes. », aucun port appelé", async () => {
    for (const input of [{ ...INPUT, worksiteId: "" }, { ...INPUT, teamId: "" }, { ...INPUT, dateFrom: "" }]) {
      const { deps, calls } = fakeDeps()
      assert.deepEqual(await assignTeamCore(input, ACTOR, deps), { ok: false, code: "VALIDATION", details: { message: "Informations manquantes." } })
      assert.deepEqual(calls, [])
    }
  })

  it("dateTo < dateFrom ⇒ VALIDATION « La date de fin doit être après la date de début. »", async () => {
    const { deps, calls } = fakeDeps()
    const r = await assignTeamCore({ ...INPUT, dateFrom: "2026-11-05", dateTo: "2026-11-03" }, ACTOR, deps)
    assert.deepEqual(r, { ok: false, code: "VALIDATION", details: { message: "La date de fin doit être après la date de début." } })
    assert.deepEqual(calls, [])
  })

  it("chantier introuvable ⇒ WORKSITE_NOT_FOUND ; équipe introuvable ⇒ TEAM_NOT_FOUND (messages identiques)", async () => {
    const w = fakeDeps({ worksite: null })
    assert.deepEqual(await assignTeamCore(INPUT, ACTOR, w.deps), { ok: false, code: "WORKSITE_NOT_FOUND", details: { message: "Chantier introuvable." } })
    assert.deepEqual(w.calls.map((c) => c.port), ["findWorksite"])
    const t = fakeDeps({ team: null })
    assert.deepEqual(await assignTeamCore(INPUT, ACTOR, t.deps), { ok: false, code: "TEAM_NOT_FOUND", details: { message: "Équipe introuvable." } })
    assert.deepEqual(t.calls.map((c) => c.port), ["findWorksite", "findTeam"])
  })

  it("conflit équipe ⇒ TEAM_CONFLICT, message avec/sans adresse, aucune transaction", async () => {
    const date = new Date("2026-11-04T12:00:00.000Z") // midi : même jour dans les deux fuseaux de capture
    const a = fakeDeps({ teamConflict: { date, worksite: { name: "Chantier Bêta", address: "3 place du Marché, Rouen" } } })
    assert.deepEqual(await assignTeamCore(INPUT, ACTOR, a.deps), {
      ok: false,
      code: "TEAM_CONFLICT",
      details: { message: "Cette équipe est déjà affectée le 04 novembre au chantier « Chantier Bêta » (3 place du Marché, Rouen). Libérez-la de ce chantier avant de la réaffecter." },
    })
    assert.ok(!a.calls.some((c) => c.port.startsWith("$transaction")))
    const b = fakeDeps({ teamConflict: { date, worksite: { name: "Chantier Bêta", address: null } } })
    const r = await assignTeamCore(INPUT, ACTOR, b.deps)
    assert.equal(r.ok === false && r.details?.message, "Cette équipe est déjà affectée le 04 novembre au chantier « Chantier Bêta ». Libérez-la de ce chantier avant de la réaffecter.")
  })

  it("conflits employés ⇒ EMPLOYEE_CONFLICT, « Désaffectez-le » (1) / « Désaffectez-les » (N)", async () => {
    const date = new Date("2026-11-04T12:00:00.000Z")
    const row = (first: string, last: string) => ({ date, employee: { firstName: first, lastName: last }, assignment: { worksite: { name: "Chantier Gamma" }, team: { name: "Équipe Sud" } } })
    const one = fakeDeps({ employeeConflicts: [row("Alice", "Martin")] })
    assert.deepEqual(await assignTeamCore(INPUT, ACTOR, one.deps), {
      ok: false,
      code: "EMPLOYEE_CONFLICT",
      details: { message: "Alice Martin est affecté le 04 novembre au chantier « Chantier Gamma » avec l'équipe Équipe Sud.\nDésaffectez-le avant de réaffecter l'équipe." },
    })
    const many = fakeDeps({ employeeConflicts: [row("Alice", "Martin"), row("Bruno", "Durand")] })
    const r = await assignTeamCore(INPUT, ACTOR, many.deps)
    assert.ok(r.ok === false && typeof r.details?.message === "string" && r.details.message.endsWith("\nDésaffectez-les avant de réaffecter l'équipe."))
  })

  it("équipe sans membres ⇒ pas de requête de conflit employés ni de createMany", async () => {
    const { deps, calls } = fakeDeps({ team: { members: [], leader: { userId: "user-leader-1" } } })
    const r = await assignTeamCore(INPUT, ACTOR, deps)
    assert.equal(r.ok, true)
    const ports = calls.map((c) => c.port)
    assert.ok(!ports.includes("findEmployeeConflicts"))
    assert.ok(!ports.includes("employeeAssignment.createMany"))
    assert.equal(ports.filter((p) => p === "assignment.create").length, 3)
  })

  it("chemin nominal ⇒ ok, data { assignmentIds (N), worksiteStatus IN_PROGRESS, leaderUserId } ; e-mail au même point (dans la transaction)", async () => {
    const { deps, calls, emails } = fakeDeps()
    const r = await assignTeamCore(INPUT, ACTOR, deps)
    assert.deepEqual(r, { ok: true, data: { assignmentIds: ["assignment-1", "assignment-2", "assignment-3"], worksiteStatus: "IN_PROGRESS", leaderUserId: "user-leader-1" } })
    const ports = calls.map((c) => c.port)
    assert.deepEqual(ports.slice(0, 5), ["findWorksite", "findTeam", "findTeamConflict", "findEmployeeConflicts", "$transaction:begin"])
    assert.equal(ports[ports.length - 1], "$transaction:commit")
    assert.ok(calls.filter((c) => c.inTx).every((c) => ports.indexOf(c.port) > ports.indexOf("$transaction:begin")))
    assert.ok(ports.includes("worksite.update") && ports.includes("notification.create") && ports.includes("user.findUnique") && ports.includes("company.findUnique"))
    assert.deepEqual(emails, [{ to: "chef@example.test", teamLeaderName: "Chef", worksiteName: "Chantier Alpha", dateLabel: emails.length ? (emails[0] as { dateLabel: string }).dateLabel : "", companyName: "Entreprise A" }])
    assert.match((emails[0] as { dateLabel: string }).dateLabel, /^du \d{2} novembre au \d{2} novembre$/)
  })

  it("chantier déjà IN_PROGRESS ⇒ pas de worksite.update, worksiteStatus inchangé ; chef sans userId ⇒ ni notification ni e-mail, leaderUserId null", async () => {
    const a = fakeDeps({ worksite: { id: "worksite-1", name: "Chantier Alpha", status: "IN_PROGRESS" } })
    const ra = await assignTeamCore(INPUT, ACTOR, a.deps)
    assert.ok(ra.ok && ra.data.worksiteStatus === "IN_PROGRESS")
    assert.ok(!a.calls.some((c) => c.port === "worksite.update"))
    const b = fakeDeps({ team: { members: [{ employeeId: "employee-1" }], leader: { userId: null } } })
    const rb = await assignTeamCore(INPUT, ACTOR, b.deps)
    assert.ok(rb.ok && rb.data.leaderUserId === null)
    assert.ok(!b.calls.some((c) => c.port === "notification.create" || c.port === "user.findUnique"))
    assert.deepEqual(b.emails, [])
  })

  it("erreur dans la transaction ⇒ rollback, TRANSACTION_FAILED { message générique, cause } ; aucun e-mail", async () => {
    const { deps, calls, emails } = fakeDeps({ failAt: "assignment.create" })
    const r = await assignTeamCore(INPUT, ACTOR, deps)
    assert.deepEqual(r, { ok: false, code: "TRANSACTION_FAILED", details: { message: "Erreur lors de la création des affectations. Veuillez réessayer.", cause: "P2002" } })
    assert.equal(calls[calls.length - 1].port, "$transaction:rollback")
    assert.deepEqual(emails, [])
  })

  it("erreurs hors transaction (findWorksite) : propagées, non capturées (comme à BASE_SHA)", async () => {
    const { deps } = fakeDeps()
    deps.findWorksite = async () => { throw new Error("db down") }
    await assert.rejects(assignTeamCore(INPUT, ACTOR, deps), { message: "db down" })
  })
})
