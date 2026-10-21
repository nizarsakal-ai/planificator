/**
 * T2bis — Isolation multi-entreprise des Server Actions (suite du ticket #77).
 * Tests COMPORTEMENTAUX sur les cœurs injectables, avec un simulateur des clauses `where` Prisma
 * (égalité, in, gte/lte, not, relations to-one imbriquées) appliqué à deux entreprises A et B,
 * dont des lignes incohérentes. Si un filtre d'entreprise manquait dans une clause, le simulateur
 * laisserait passer la ligne étrangère : c'est ce que les cas « fuite » vérifient.
 *
 * F1 getDailyReport · F3 deletePendingInvitations · F4 addEmployeeToBlock · F5 upsertDailyReport ·
 * F2 markAsRead (contrat de source : action à Prisma direct, une ligne).
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"
process.env.RESEND_API_KEY ??= "re_test_dummy_for_unit"

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import { inviterMembreImpl, type InviterMembreDeps } from "@/lib/actions/invitation-invite.core"
import {
  getDailyReportCore,
  upsertDailyReportCore,
  type DailyReportDeps,
  type ExistingDailyReport,
} from "@/lib/actions/daily-report.core"
import {
  addEmployeeToBlockCore,
  buildBlockConflictsWhere,
  type BlockDeps,
  type ConflictRow,
} from "@/lib/actions/chantier-block.core"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")

// ---- Simulateur de clause where Prisma (sous-ensemble utilisé par les cœurs) ----------------------

type Where = Record<string, unknown>
function matches(row: Record<string, unknown>, where: Where): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue
    const value = row[key]
    if (cond instanceof Date) {
      if (!(value instanceof Date) || value.getTime() !== cond.getTime()) return false
    } else if (cond !== null && typeof cond === "object") {
      const c = cond as Record<string, unknown>
      const isOp = ["in", "gte", "lte", "gt", "lt", "not", "equals"].some((k) => k in c)
      if (isOp) {
        const t = (x: unknown) => (x instanceof Date ? x.getTime() : x)
        if ("equals" in c && t(value) !== t(c.equals)) return false
        if ("in" in c && !(c.in as unknown[]).some((x) => t(x) === t(value))) return false
        if ("not" in c && t(value) === t(c.not)) return false
        if ("gte" in c && (t(value) as number) < (t(c.gte) as number)) return false
        if ("lte" in c && (t(value) as number) > (t(c.lte) as number)) return false
      } else {
        if (value === null || typeof value !== "object") return false
        if (!matches(value as Record<string, unknown>, c)) return false
      }
    } else if (value !== cond) return false
  }
  return true
}

// ---- Jeu de données : entreprises A et B, avec lignes incohérentes -------------------------------

const D1 = new Date("2026-10-21T00:00:00.000Z")
const D2 = new Date("2026-10-22T00:00:00.000Z")

const companies = { A: "co-A", B: "co-B" }
const employees = [
  { id: "empA1", userId: "uA1", companyId: companies.A }, // chef d'équipe A
  { id: "empA2", userId: "uA2", companyId: companies.A },
  { id: "empB1", userId: "uB1", companyId: companies.B },
]
const worksites = [
  { id: "wsA1", companyId: companies.A, name: "Chantier A1" },
  { id: "wsA2", companyId: companies.A, name: "Chantier A2" },
  { id: "wsB1", companyId: companies.B, name: "Chantier B secret" },
]
const teams = [
  { id: "teamA", companyId: companies.A, leaderId: "empA1", name: "Équipe A" },
  { id: "teamB", companyId: companies.B, leaderId: "empB1", name: "Équipe B confidentielle" },
]
const rel = <T extends { id: string }>(list: T[], id: string) => list.find((x) => x.id === id)!
const withRel = (a: { id: string; worksiteId: string; teamId: string; date: Date }) => ({
  ...a,
  worksite: rel(worksites, a.worksiteId),
  team: rel(teams, a.teamId),
})
const assignments = [
  { id: "asgA1", worksiteId: "wsA1", teamId: "teamA", date: D1 },
  { id: "asgA2", worksiteId: "wsA1", teamId: "teamA", date: D2 },
  // Incohérente : chantier de A, équipe de B (donnée corrompue ou attaque)
  { id: "asgX", worksiteId: "wsA1", teamId: "teamB", date: D2 },
  // Incohérente inverse : chantier de A2, équipe de B — l'employé A2 y est déjà affecté le D1
  { id: "asgY", worksiteId: "wsA2", teamId: "teamB", date: D1 },
  { id: "asgB1", worksiteId: "wsB1", teamId: "teamB", date: D1 },
].map(withRel)

function blockHarness(opts: { role?: string; companyId?: string | null; preexisting?: { assignmentId: string; employeeId: string; date: Date }[] } = {}) {
  const employeeAssignments = [...(opts.preexisting ?? [])]
  const created: { assignmentId: string; employeeId: string; date: Date }[] = []
  const queries: { assignments?: Where; conflicts?: Where } = {}
  const deps: BlockDeps = {
    auth: async () => ({ user: { id: "u", role: opts.role ?? "ADMIN", companyId: opts.companyId === undefined ? companies.A : opts.companyId } }),
    findWorksite: async (where) => (worksites.find((w) => matches(w, where as Where)) ?? null),
    findEmployee: async (where) => (employees.find((e) => matches(e, where as Where)) ?? null),
    findAssignments: async (where) => { queries.assignments = where as Where; return assignments.filter((a) => matches(a, where as Where)).map(({ id, date }) => ({ id, date })) },
    createEmployeeAssignment: async (data) => {
      // Contrainte unique (employeeId, date) comme en base
      if (employeeAssignments.some((ea) => ea.employeeId === data.employeeId && ea.date.getTime() === data.date.getTime())) throw new Error("P2002")
      employeeAssignments.push(data); created.push(data)
    },
    findConflicts: async (where) => {
      queries.conflicts = where as Where
      return employeeAssignments
        .map((ea) => ({ ...ea, assignment: rel(assignments, ea.assignmentId) }))
        .filter((row) => matches(row, where as Where))
        .map((row): ConflictRow => ({ date: row.date, assignment: { worksite: { name: row.assignment.worksite.name }, team: { name: row.assignment.team.name } } }))
    },
    revalidate: () => {},
  }
  return { deps, created, queries, employeeAssignments }
}

describe("F4 — addEmployeeToBlock : isolation par entreprise (comportemental)", () => {
  const block = { worksiteId: "wsA1", teamId: "teamA", startDate: "2026-10-21", endDate: "2026-10-22" }

  it("cas positif : ADMIN A ajoute un employé A sur son bloc ⇒ 2 affectations créées, 0 conflit", async () => {
    const h = blockHarness()
    const r = await addEmployeeToBlockCore({ ...block, employeeId: "empA2" }, h.deps)
    assert.deepEqual(r, { success: true, added: 2, skipped: 0, conflicts: [] })
    assert.deepEqual(h.created.map((c) => c.assignmentId).sort(), ["asgA1", "asgA2"])
  })

  it("employé d'une autre entreprise ⇒ refus, aucune écriture", async () => {
    const h = blockHarness()
    const r = await addEmployeeToBlockCore({ ...block, employeeId: "empB1" }, h.deps)
    assert.deepEqual(r, { error: "Employé introuvable" })
    assert.equal(h.created.length, 0)
  })

  it("chantier d'une autre entreprise ⇒ refus (ADMIN) ; SUPER_ADMIN y accède mais l'employé doit être de l'entreprise du chantier", async () => {
    const admin = blockHarness()
    assert.deepEqual(await addEmployeeToBlockCore({ ...block, worksiteId: "wsB1", teamId: "teamB", employeeId: "empB1" }, admin.deps), { error: "Chantier introuvable" })
    const sa = blockHarness({ role: "SUPER_ADMIN", companyId: null })
    assert.deepEqual(await addEmployeeToBlockCore({ ...block, worksiteId: "wsB1", teamId: "teamB", employeeId: "empA2" }, sa.deps), { error: "Employé introuvable" })
    const ok = await addEmployeeToBlockCore({ ...block, worksiteId: "wsB1", teamId: "teamB", employeeId: "empB1" }, sa.deps)
    assert.ok("success" in ok && ok.added === 1)
  })

  it("affectation incohérente (chantier A, équipe B) : jamais modifiée, même en ciblant son équipe", async () => {
    const h = blockHarness()
    const r = await addEmployeeToBlockCore({ ...block, teamId: "teamB", employeeId: "empA2" }, h.deps)
    assert.deepEqual(r, { success: true, added: 0, skipped: 0, conflicts: [] })
    assert.equal(h.created.length, 0, "asgX (équipe étrangère) ne doit pas recevoir d'affectation")
  })

  it("conflit sur une affectation incohérente : le nom de l'équipe étrangère n'est PAS révélé", async () => {
    // empA2 est déjà affecté le D1 sur asgY (chantier A2, équipe B) ⇒ création sur asgA1 (D1) échoue ⇒ conflit à expliquer
    const h = blockHarness({ preexisting: [{ assignmentId: "asgY", employeeId: "empA2", date: D1 }] })
    const r = await addEmployeeToBlockCore({ ...block, employeeId: "empA2" }, h.deps)
    assert.ok("success" in r)
    assert.equal(r.added, 1)
    assert.equal(r.skipped, 1)
    assert.deepEqual(r.conflicts, [], "la ligne incohérente est filtrée : aucun nom d'équipe B ne sort")
    assert.equal(JSON.stringify(r).includes("confidentielle"), false)
  })

  it("conflit légitime (même entreprise) : chantier et équipe sont bien renvoyés", async () => {
    const h = blockHarness({ preexisting: [{ assignmentId: "asgA2", employeeId: "empA2", date: D2 }] })
    const r = await addEmployeeToBlockCore({ ...block, employeeId: "empA2" }, h.deps)
    assert.ok("success" in r)
    assert.equal(r.added, 1)
    assert.deepEqual(r.conflicts.map((c) => [c.iso, c.worksiteName, c.teamName]), [["2026-10-22", "Chantier A1", "Équipe A"]])
  })

  it("preuve de discrimination : sans le filtre team.companyId, la clause de conflits révélerait l'équipe B", () => {
    const full = buildBlockConflictsWhere("empA2", [D1], companies.A) as Where
    const leaky = { ...full, assignment: { worksite: { companyId: companies.A } } }
    const row = { employeeId: "empA2", date: D1, assignment: rel(assignments, "asgY") }
    assert.equal(matches(row, full), false)
    assert.equal(matches(row, leaky), true, "la version sans filtre équipe laisse passer asgY")
  })
})

// ---- F1 / F5 : rapports journaliers --------------------------------------------------------------

type ReportRow = { id: string; worksiteId: string; teamId: string; date: Date; createdById: string; description: string }
function reportHarness(opts: { role?: string; companyId?: string | null; userId?: string; reports?: ReportRow[] } = {}) {
  const reports: ReportRow[] = [...(opts.reports ?? [])]
  const writes: { kind: "create" | "update"; teamId: string; worksiteId?: string }[] = []
  const withRels = (r: ReportRow) => ({ ...r, worksite: rel(worksites, r.worksiteId), team: rel(teams, r.teamId) })
  const deps: DailyReportDeps = {
    auth: async () => ({ user: { id: opts.userId ?? "uA1", role: opts.role ?? "TEAM_LEADER", companyId: opts.companyId === undefined ? companies.A : opts.companyId } }),
    findEmployee: async (where) => employees.find((e) => matches(e, where as Where)) ?? null,
    findTeam: async (where) => teams.find((t) => matches(t, where as Where)) ?? null,
    findWorksite: async (where) => worksites.find((w) => matches(w, where as Where)) ?? null,
    findExistingReport: async (where) => {
      const r = reports.map(withRels).find((x) => matches(x, where as Where))
      return r ? ({ id: r.id, worksiteId: r.worksiteId, worksite: { companyId: r.worksite.companyId } } satisfies ExistingDailyReport) : null
    },
    upsertReport: async ({ where, create, update }) => {
      const ex = reports.find((r) => r.teamId === where.teamId_date.teamId && r.date.getTime() === where.teamId_date.date.getTime())
      if (ex) { writes.push({ kind: "update", teamId: ex.teamId, worksiteId: ex.worksiteId }); ex.description = String(update.description) }
      else { writes.push({ kind: "create", teamId: create.teamId, worksiteId: create.worksiteId }); reports.push({ id: `r${reports.length + 1}`, worksiteId: create.worksiteId, teamId: create.teamId, date: create.date as Date, createdById: create.createdById, description: create.description }) }
    },
    findReport: async (where) => reports.map(withRels).find((x) => matches(x, where as Where)) ?? null,
    revalidate: () => {},
  }
  return { deps, writes, reports }
}
const baseInput = { worksiteId: "wsA1", teamId: "teamA", date: "2026-10-21", weather: "SUNNY" as const, description: "RAS", issues: "", hoursWorked: 7 }

describe("F5 — upsertDailyReport : isolation par entreprise (comportemental)", () => {
  it("cas positif : création d'un rapport sur son chantier, par le chef de l'équipe", async () => {
    const h = reportHarness()
    assert.deepEqual(await upsertDailyReportCore(baseInput, h.deps), { success: true })
    assert.deepEqual(h.writes, [{ kind: "create", teamId: "teamA", worksiteId: "wsA1" }])
  })
  it("cas positif : mise à jour d'un rapport existant de la même entreprise", async () => {
    const h = reportHarness({ reports: [{ id: "r1", worksiteId: "wsA1", teamId: "teamA", date: D1, createdById: "empA1", description: "ancien" }] })
    assert.deepEqual(await upsertDailyReportCore({ ...baseInput, description: "nouveau" }, h.deps), { success: true })
    assert.deepEqual(h.writes, [{ kind: "update", teamId: "teamA", worksiteId: "wsA1" }])
    assert.equal(h.reports[0].description, "nouveau")
  })
  it("chantier d'une autre entreprise ⇒ refus, aucune écriture", async () => {
    const h = reportHarness()
    assert.deepEqual(await upsertDailyReportCore({ ...baseInput, worksiteId: "wsB1" }, h.deps), { error: "Chantier introuvable" })
    assert.equal(h.writes.length, 0)
  })
  it("rapport existant (équipe A, date) rattaché à un chantier étranger ⇒ refus explicite, ni modifié ni réparé", async () => {
    const h = reportHarness({ reports: [{ id: "r1", worksiteId: "wsB1", teamId: "teamA", date: D1, createdById: "empA1", description: "ancien" }] })
    assert.deepEqual(await upsertDailyReportCore({ ...baseInput, description: "tentative" }, h.deps), { error: "Rapport introuvable" })
    assert.equal(h.writes.length, 0)
    assert.equal(h.reports[0].description, "ancien")
    assert.equal(h.reports[0].worksiteId, "wsB1", "pas de réparation silencieuse")
  })
  it("non chef de l'équipe, ou équipe d'une autre entreprise, ou session sans companyId ⇒ refus", async () => {
    assert.deepEqual(await upsertDailyReportCore({ ...baseInput, teamId: "teamB" }, reportHarness().deps), { error: "Vous n'êtes pas chef de cette équipe" })
    assert.deepEqual(await upsertDailyReportCore(baseInput, reportHarness({ userId: "uA2" }).deps), { error: "Vous n'êtes pas chef de cette équipe" })
    assert.deepEqual(await upsertDailyReportCore(baseInput, reportHarness({ companyId: null }).deps), { error: "Non autorisé" })
    assert.deepEqual(await upsertDailyReportCore(baseInput, reportHarness({ role: "ADMIN" }).deps), { error: "Non autorisé" })
  })
})

describe("F1 — getDailyReport : lecture bornée à l'entreprise (comportemental)", () => {
  const reports: ReportRow[] = [
    { id: "rA", worksiteId: "wsA1", teamId: "teamA", date: D1, createdById: "empA1", description: "A" },
    { id: "rB", worksiteId: "wsB1", teamId: "teamB", date: D1, createdById: "empB1", description: "B secret" },
    { id: "rX", worksiteId: "wsB1", teamId: "teamA", date: D2, createdById: "empA1", description: "incohérent" },
  ]
  it("cas positif : rapport de sa propre équipe/chantier", async () => {
    const r = await getDailyReportCore("teamA", "2026-10-21", reportHarness({ reports }).deps)
    assert.equal(r?.id, "rA")
  })
  it("équipe d'une autre entreprise ⇒ null", async () => {
    assert.equal(await getDailyReportCore("teamB", "2026-10-21", reportHarness({ reports }).deps), null)
  })
  it("rapport incohérent (équipe A, chantier B) ⇒ null pour A ET pour B", async () => {
    assert.equal(await getDailyReportCore("teamA", "2026-10-22", reportHarness({ reports }).deps), null)
    assert.equal(await getDailyReportCore("teamA", "2026-10-22", reportHarness({ reports, companyId: companies.B, userId: "uB1" }).deps), null)
  })
  it("session sans companyId ou absente ⇒ null", async () => {
    assert.equal(await getDailyReportCore("teamA", "2026-10-21", reportHarness({ reports, companyId: null }).deps), null)
    assert.equal(await getDailyReportCore("teamA", "2026-10-21", { auth: async () => null, findReport: async () => { throw new Error("ne doit pas être appelé") } }), null)
  })
})

// ---- F3 : invitations ------------------------------------------------------------------------------

describe("F3 — inviterMembre : suppression des invitations en attente bornée à l'entreprise", () => {
  it("transmet le companyId de la session au port de suppression", async () => {
    const deleted: { email: string; companyId: string }[] = []
    const d: InviterMembreDeps = {
      requireSession: async () => ({ id: "admin-1", role: "ADMIN", companyId: companies.A, name: "Admin" }),
      findExistingUser: async () => null,
      deletePendingInvitations: async (email, co) => { deleted.push({ email, companyId: co }) },
      findCompanyName: async () => "Entreprise A",
      createInvitation: async () => ({}),
      sendEmail: async () => {},
      revalidate: () => {},
    }
    const fd = new FormData(); fd.set("email", "x@example.com"); fd.set("role", "EMPLOYEE")
    await inviterMembreImpl(fd, d)
    assert.deepEqual(deleted, [{ email: "x@example.com", companyId: companies.A }])
  })
  it("l'adaptateur Prisma filtre bien par companyId", () => {
    const src = readFileSync(join(ROOT, "src/lib/actions/invitation.actions.ts"), "utf8")
    assert.match(src, /deletePendingInvitations:\s*\(email,\s*companyId\)\s*=>\s*prisma\.invitation\.deleteMany\(\{\s*where:\s*\{\s*email,\s*companyId,\s*status:\s*"PENDING"\s*\}/)
  })
})

// ---- F2 : notification (action à Prisma direct, une ligne) -----------------------------------------

describe("F2 — notification.actions.markAsRead : propriété de l'utilisateur", () => {
  it("met à jour uniquement { id, userId: session.user.id }", () => {
    const src = readFileSync(join(ROOT, "src/lib/actions/notification.actions.ts"), "utf8")
    const body = src.slice(src.indexOf("export async function markAsRead"))
    assert.doesNotMatch(body, /notification\.update\(/)
    assert.match(body, /notification\.updateMany\(\{\s*where:\s*\{\s*id:\s*notificationId,\s*userId:\s*session\.user\.id\s*\}/)
  })
})
