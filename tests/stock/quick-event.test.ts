/** Client / événement saisi à la main depuis Stock ou Matériel (client particulier). */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { NEW_EVENT, readQuickEvent, resolveWorksite, validateQuickEvent } from "@/lib/integration/quick-event"

const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f }
const ctx = { companyId: "c1", userId: "u1" }

describe("client / événement manuel", () => {
  it("exige le nom du client et un e-mail valide s'il est saisi", () => {
    assert.match(validateQuickEvent(readQuickEvent(fd({}))) ?? "", /nom du client/)
    assert.match(validateQuickEvent(readQuickEvent(fd({ newClientName: "Mme Dupont", newClientEmail: "x" }))) ?? "", /E-mail/)
    assert.equal(validateQuickEvent(readQuickEvent(fd({ newClientName: "Mme Dupont" }))), null)
  })
  it("chantier existant ou aucun : aucune écriture", async () => {
    const db = {} as never
    assert.deepEqual(await resolveWorksite(db, ctx, fd({ worksiteId: "w1" })), { ok: true, worksiteId: "w1" })
    assert.deepEqual(await resolveWorksite(db, ctx, fd({ worksiteId: "" })), { ok: true, worksiteId: null })
  })
  it("nouveau client : crée le client et l'événement dans l'entreprise de la session, réutilise un client du même nom", async () => {
    const created: Record<string, unknown>[] = []
    const tx = {
      client: { findFirst: async () => null, create: async (a: { data: Record<string, unknown> }) => { created.push({ client: a.data }); return { id: "cl1" } } },
      worksite: { create: async (a: { data: Record<string, unknown> }) => { created.push({ worksite: a.data }); return { id: "w9", name: a.data.name } } },
      historyLog: { create: async () => ({}) },
    }
    const db = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) } as never
    const r = await resolveWorksite(db, ctx, fd({ worksiteId: NEW_EVENT, newClientName: "Mme Dupont", newClientPhone: "0600000000" }), { first: new Date("2026-12-05"), last: new Date("2026-12-06") })
    assert.deepEqual(r, { ok: true, worksiteId: "w9" })
    const c = created[0].client as Record<string, unknown>, w = created[1].worksite as Record<string, unknown>
    assert.equal(c.companyId, "c1"); assert.equal(c.name, "Mme Dupont")
    assert.equal(w.companyId, "c1"); assert.equal(w.clientId, "cl1"); assert.equal(w.name, "Location – Mme Dupont")
  })
})
