import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { resolveWorksiteViewer, worksiteAccessWhere } from "../../src/lib/chantiers/worksite-access"
import { accessAcquisitionAttachment } from "../../src/lib/acquisition/access/attachment-access.service"

// Données synthétiques uniquement. Incident 18/11 : un chef d'équipe voyait son chantier dans la liste et
// tombait sur « 404 Page introuvable » à l'ouverture ; un salarié ne pouvait pas ouvrir les pièces jointes.
const db = (row: { id: string; ledTeams: { id: string }[] } | null) => {
  const seen: unknown[] = []
  return { seen, db: { employee: { findFirst: async (args: unknown) => { seen.push(args); return row } } } }
}

describe("périmètre d'accès aux chantiers : une seule règle", () => {
  it("administrateur et super administrateur : tous les chantiers de l'entreprise, sans lecture du profil", async () => {
    for (const role of ["ADMIN", "SUPER_ADMIN"]) {
      const { db: d, seen } = db(null)
      assert.deepEqual(worksiteAccessWhere(await resolveWorksiteViewer(d, { id: "u", role, companyId: "c" })), {})
      assert.equal(seen.length, 0)
    }
  })
  it("chef d'équipe : TOUTES ses équipes actives et ses affectations personnelles", async () => {
    const { db: d, seen } = db({ id: "e1", ledTeams: [{ id: "t1" }, { id: "t2" }] })
    const viewer = await resolveWorksiteViewer(d, { id: "u", role: "TEAM_LEADER", companyId: "c" })
    assert.deepEqual(worksiteAccessWhere(viewer), { OR: [
      { assignments: { some: { employeeAssignments: { some: { employeeId: "e1" } } } } },
      { assignments: { some: { teamId: { in: ["t1", "t2"] } } } },
    ] })
    assert.deepEqual(seen, [{ where: { userId: "u", companyId: "c", active: true },
      select: { id: true, ledTeams: { where: { active: true }, select: { id: true } } } }])
  })
  it("chef d'équipe sans équipe active : ses affectations personnelles (plus de redirection systématique)", async () => {
    const { db: d } = db({ id: "e1", ledTeams: [] })
    assert.deepEqual(worksiteAccessWhere(await resolveWorksiteViewer(d, { id: "u", role: "TEAM_LEADER", companyId: "c" })),
      { assignments: { some: { employeeAssignments: { some: { employeeId: "e1" } } } } })
  })
  it("salarié : seulement les chantiers où il est affecté, même s'il dirigeait une équipe en base", async () => {
    const { db: d } = db({ id: "e2", ledTeams: [{ id: "t9" }] })
    assert.deepEqual(worksiteAccessWhere(await resolveWorksiteViewer(d, { id: "u", role: "EMPLOYEE", companyId: "c" })),
      { assignments: { some: { employeeAssignments: { some: { employeeId: "e2" } } } } })
  })
  it("client, rôle inconnu, profil absent ou session incomplète : aucun accès", async () => {
    for (const user of [{ id: "u", role: "CLIENT", companyId: "c" }, { id: "u", role: "OTHER", companyId: "c" },
      { id: "u", role: "EMPLOYEE", companyId: null }, { id: null, role: "ADMIN", companyId: "c" }]) {
      const { db: d } = db({ id: "e", ledTeams: [] })
      assert.equal(worksiteAccessWhere(await resolveWorksiteViewer(d, user)), null)
    }
    const { db: d } = db(null)
    assert.equal(worksiteAccessWhere(await resolveWorksiteViewer(d, { id: "u", role: "EMPLOYEE", companyId: "c" })), null)
  })
  it("liste, fiche, calendrier et documents appliquent tous cette règle", () => {
    const read = (p: string) => readFileSync(p, "utf8")
    assert.match(read("src/app/(dashboard)/chantiers/page.tsx"), /const worksiteWhere = \{ companyId, \.\.\.scope \}/)
    assert.match(read("src/app/(dashboard)/chantiers/[id]/page.tsx"), /companyId: session\.user\.companyId!,\s*\.\.\.scope,/)
    assert.doesNotMatch(read("src/app/(dashboard)/chantiers/[id]/page.tsx"), /ledTeams\[0\]/)
    assert.match(read("src/app/(dashboard)/planning/calendrier/page.tsx"), /canOpen: openable\.has\(a\.worksite\.id\)/)
    assert.match(read("src/components/planning/CalendarView.tsx"), /a\.canOpen === false \? \(\s*<span/)
    const docs = read("src/app/api/documents/[id]/route.ts")
    assert.match(docs, /worksite: \{ companyId: session\.user\.companyId!, \.\.\.scope \}/)
    assert.match(docs, /authorizedByWorksite: true/)
    assert.doesNotMatch(docs, /NextResponse\.redirect\(\s*new URL\(`\/api\/acquisition\/attachments/)
  })
})

describe("pièce jointe versée dans un chantier : ouverte depuis le chantier par un salarié", () => {
  const prev = { ...process.env }
  const withEnv = async (fn: () => Promise<void>) => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"; process.env.ACQUISITION_ATTACHMENT_ACCESS_ENABLED = "true"
    try { await fn() } finally { process.env = { ...prev } }
  }
  const ctx = { userId: "u", role: "EMPLOYEE" as const, companyId: "c" }
  const deps = (hits: string[]) => ({
    repository: { findConsultableAttachment: async () => { hits.push("find"); return null } },
    auditRepository: { record: async () => { hits.push("audit") } },
    log: () => {},
  })
  it("depuis la route des consultations : refusé au salarié (règle du back-office inchangée)", () => withEnv(async () => {
    const hits: string[] = []
    const r = await accessAcquisitionAttachment({ context: ctx, attachmentId: "a", mode: "VIEW" }, deps(hits) as never)
    assert.equal(r.kind, "FORBIDDEN"); assert.deepEqual(hits, [])
  }))
  it("depuis le chantier : le rôle n'est plus un obstacle, l'entreprise et l'audit restent exigés", () => withEnv(async () => {
    const hits: string[] = []
    const r = await accessAcquisitionAttachment({ context: ctx, attachmentId: "a", mode: "VIEW", authorizedByWorksite: true }, deps(hits) as never)
    assert.equal(r.kind, "NOT_FOUND"); assert.deepEqual(hits, ["find", "audit"])
    const none = await accessAcquisitionAttachment({ context: { ...ctx, companyId: null }, attachmentId: "a", mode: "VIEW", authorizedByWorksite: true }, deps([]) as never)
    assert.equal(none.kind, "FORBIDDEN")
  }))
})
