import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { PrismaHrTx } from "../../src/lib/hr-documents/repository"

// Données synthétiques. Explique un « Mes documents » vide : compte rattaché à la fiche et documents réellement publiés.
type Row = { status: string; _count: { _all: number } }
function tx(employee: unknown, counts: Row[]) {
  const db = {
    employee: { findFirst: async () => employee },
    hrDocument: { groupBy: async () => counts },
  }
  return new PrismaHrTx(db as never, () => undefined)
}
const account = (o: Partial<{ email: string; active: boolean; lastLoginAt: Date | null }> = {}) =>
  ({ email: "alex@example.test", active: true, lastLoginAt: new Date("2026-11-18T10:00:00Z"), ...o })

describe("visibilité côté salarié", () => {
  it("compte les publiés comme visibles, le reste comme en attente ou suspendu", async () => {
    const s = await tx({ active: true, user: account(), hrDraft: null },
      [{ status: "PUBLISHED", _count: { _all: 2 } }, { status: "READY", _count: { _all: 3 } }, { status: "REVIEWED", _count: { _all: 1 } }, { status: "BLOCKED", _count: { _all: 1 } }])
      .employeeAccess("c", "e")
    assert.deepEqual({ ...s, lastLoginAt: undefined }, { email: "alex@example.test", placeholderEmail: false, accountActive: true, employeeActive: true,
      draft: false, lastLoginAt: undefined, visible: 2, pending: 4, blocked: 1 })
  })
  it("fiche à compléter : adresse réservée masquée, signalée comme sans compte réel", async () => {
    const s = await tx({ active: false, user: account({ email: "rh-fiche-x@fiche-a-completer.invalid", active: false }), hrDraft: { status: "OPEN" } }, [])
      .employeeAccess("c", "e")
    assert.equal(s?.email, null); assert.equal(s?.placeholderEmail, true); assert.equal(s?.draft, true); assert.equal(s?.visible, 0)
  })
  it("fiche d'une autre entreprise ou inconnue : null", async () => {
    assert.equal(await tx(null, []).employeeAccess("c", "e"), null)
  })
})
describe("fiches à compléter désactivées (table absente en production)", () => {
  it("ne lit jamais la relation hrDraft sans le drapeau", async () => {
    const previous = process.env.HR_DOCUMENT_EMPLOYEE_DRAFTS_ENABLED
    delete process.env.HR_DOCUMENT_EMPLOYEE_DRAFTS_ENABLED
    try {
      let select: Record<string, unknown> = {}
      const db = { employee: { findFirst: async (a: { select: Record<string, unknown> }) => { select = a.select; return { active: true, user: account() } } },
        hrDocument: { groupBy: async () => [] } }
      const s = await new PrismaHrTx(db as never, () => undefined).employeeAccess("c", "e")
      assert.equal("hrDraft" in select, false); assert.equal(s?.draft, false)
    } finally { if (previous === undefined) delete process.env.HR_DOCUMENT_EMPLOYEE_DRAFTS_ENABLED; else process.env.HR_DOCUMENT_EMPLOYEE_DRAFTS_ENABLED = previous }
  })
})
