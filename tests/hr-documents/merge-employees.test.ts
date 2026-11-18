import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { PrismaHrTx } from "../../src/lib/hr-documents/repository"
import { mergeSchema } from "../../src/lib/hr-documents/domain"

// Données synthétiques uniquement. Incident 18/11 : deux fiches pour le même salarié ; ses documents étaient sur la
// fiche sans compte, il n'en voyait aucun dans « Mes documents ».
type Doc = { id: string; companyId: string; employeeId: string; category: string; period: string; sha256: string }
function fakeDb(o: { docs: Doc[]; draft?: { id: string; status: string } | null; targetActive?: boolean; sourceExists?: boolean }) {
  const state = { docs: o.docs.map(d => ({ ...d })), messages: [{ id: "m1", companyId: "c", employeeId: "src" }],
    draftStatus: o.draft?.status, sourceActive: true, history: [] as unknown[] }
  const matches = (d: Doc, w: { companyId: string; employeeId: string }) => d.companyId === w.companyId && d.employeeId === w.employeeId
  const db = {
    $queryRaw: async () => [],
    employee: {
      findFirst: async ({ where }: { where: { id: string } }) => where.id === "tgt"
        ? (o.targetActive === false ? null : { id: "tgt", firstName: "Alex", lastName: "Martin" })
        : (o.sourceExists === false ? null : { id: "src", active: true, firstName: "alex", lastName: "martin", hrDraft: o.draft ?? null }),
      update: async () => { state.sourceActive = false },
    },
    hrDocument: {
      findMany: async ({ where }: { where: { companyId: string; employeeId: string } }) => state.docs.filter(d => matches(d, where)),
      findFirst: async ({ where }: { where: { companyId: string; employeeId: string; OR: Partial<Doc>[] } }) =>
        state.docs.find(d => matches(d, where) && where.OR.some(k => k.category === d.category && k.period === d.period && k.sha256 === d.sha256)) ?? null,
      updateMany: async ({ where, data }: { where: { companyId: string; employeeId: string }; data: { employeeId: string } }) => {
        const hit = state.docs.filter(d => matches(d, where)); hit.forEach(d => { d.employeeId = data.employeeId }); return { count: hit.length }
      },
    },
    hrMessage: { updateMany: async ({ data }: { data: { employeeId: string } }) => { state.messages.forEach(m => { m.employeeId = data.employeeId }); return { count: state.messages.length } } },
    hrEmployeeDraft: { update: async ({ data }: { data: { status: string } }) => { state.draftStatus = data.status } },
    historyLog: { create: async ({ data }: { data: unknown }) => { state.history.push(data) } },
  }
  return { tx: new PrismaHrTx(db as never, () => undefined), state }
}
const doc = (id: string, employeeId: string, sha256 = id): Doc => ({ id, companyId: "c", employeeId, category: "ID_CARD", period: "2026-11", sha256 })

describe("fusion de deux dossiers du même salarié", () => {
  it("tous les documents (publiés compris) et messages passent sur la fiche conservée ; la fiche doublon est désactivée", async () => {
    const { tx, state } = fakeDb({ docs: [doc("d1", "src"), doc("d2", "src"), doc("d3", "tgt")] })
    assert.deepEqual(await tx.mergeEmployees("c", "src", "tgt", "admin"), { documents: 2, messages: 1, source: "EMPLOYEE" })
    assert.deepEqual(state.docs.map(d => d.employeeId), ["tgt", "tgt", "tgt"])
    assert.equal(state.messages[0].employeeId, "tgt"); assert.equal(state.sourceActive, false); assert.equal(state.history.length, 1)
  })
  it("fiche à compléter ouverte : brouillon marqué fusionné, la fiche reste telle quelle", async () => {
    const { tx, state } = fakeDb({ docs: [doc("d1", "src")], draft: { id: "dr", status: "OPEN" } })
    assert.equal((await tx.mergeEmployees("c", "src", "tgt", "admin")).source, "DRAFT")
    assert.equal(state.draftStatus, "MERGED"); assert.equal(state.sourceActive, true)
  })
  it("pièce identique déjà sur la fiche conservée : refus, rien n'est déplacé", async () => {
    const { tx, state } = fakeDb({ docs: [doc("d1", "src", "same"), doc("d2", "tgt", "same")] })
    await assert.rejects(tx.mergeEmployees("c", "src", "tgt", "admin"), /DUPLICATE/)
    assert.equal(state.docs[0].employeeId, "src"); assert.equal(state.history.length, 0)
  })
  it("fiche conservée inactive, source introuvable ou brouillon déjà fusionné : refus sans effet", async () => {
    for (const o of [{ targetActive: false }, { sourceExists: false }, { draft: { id: "dr", status: "MERGED" } }]) {
      const { tx, state } = fakeDb({ docs: [doc("d1", "src")], ...o })
      await assert.rejects(tx.mergeEmployees("c", "src", "tgt", "admin"))
      assert.equal(state.docs[0].employeeId, "src")
    }
  })
  it("entrée : deux fiches distinctes exigées ; action réservée aux personnes habilitées à importer ET publier", () => {
    assert.equal(mergeSchema.safeParse({ sourceEmployeeId: "a", targetEmployeeId: "a" }).success, false)
    assert.equal(mergeSchema.safeParse({ sourceEmployeeId: "a", targetEmployeeId: "b", x: 1 }).success, false)
    const service = readFileSync("src/lib/hr-documents/service.ts", "utf8")
    assert.match(service, /requireCapability\(a,"IMPORT"\);requireCapability\(a,"PUBLISH"\);requireCapability\(a,"READ"\)\s*return tx\.mergeEmployees/)
    const route = readFileSync("src/app/api/hr-documents/merge/route.ts", "utf8")
    assert.match(route, /assertMutationOrigin\(request\); await hrOperator\(identity, "PUBLISH"\)/)
    assert.match(readFileSync("src/components/hr-documents/Documents.tsx", "utf8"), /manage&&employeeId&&canImport&&canPublish&&<MergePanel/)
  })
})
