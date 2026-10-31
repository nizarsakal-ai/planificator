/**
 * Destinataires des photos — action `updateChantier` avec doubles de modules (session, Prisma, géocodage, cœur, cache).
 * Prouve : refus par rôle ou par forme AVANT toute lecture/écriture ; champ absent ⇒ écriture historique inchangée,
 * sans toucher aux destinataires ; champ fourni par un SUPER_ADMIN ⇒ cœur transactionnel seul.
 * Exécution : `node --import tsx --experimental-test-module-mocks --test <fichier>` (script test:worksite-photos).
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { before, beforeEach, describe, it, mock } from "node:test"

type Call = { target: string; args: unknown }
const calls: Call[] = []
let session: { user: { id: string; role: string; companyId: string | null } } | null = null
let coreResult: { ok: true; changed: boolean; diff: unknown } | { ok: false; code: string } = { ok: true, changed: true, diff: {} }

const prismaDouble = {
  worksite: {
    findFirst: async (args: unknown) => { calls.push({ target: "worksite.findFirst", args }); return { id: "w1", companyId: "c1", address: "1 rue A", latitude: 1, longitude: 2 } },
    update: async (args: unknown) => { calls.push({ target: "worksite.update", args }); return {} },
  },
  client: { findFirst: async (args: unknown) => { calls.push({ target: "client.findFirst", args }); return { id: "cl1" } } },
  $transaction: async () => { calls.push({ target: "$transaction", args: null }); throw new Error("transaction directe inattendue") },
}

let updateChantier: (worksiteId: string, formData: FormData) => Promise<{ error?: string; success?: boolean }>

before(async () => {
  mock.module("@/auth", { namedExports: { auth: async () => session } })
  mock.module("@/lib/prisma", { namedExports: { prisma: prismaDouble } })
  mock.module("@/lib/geo/geocode.port", { namedExports: { defaultGeocodePort: { geocodeAddress: async (a: string) => { calls.push({ target: "geocode", args: a }); return { latitude: 3, longitude: 4 } } } } })
  mock.module("@/lib/email", { namedExports: { sendAssignmentCreatedEmail: async () => undefined, sendAssignmentConfirmedEmail: async () => undefined, sendAssignmentRefusedEmail: async () => undefined } })
  mock.module("next/cache", { namedExports: { revalidatePath: (p: string) => { calls.push({ target: "revalidate", args: p }) } } })
  mock.module("@/lib/actions/chantier-photo-recipients.core", {
    namedExports: { updateWorksiteWithPhotoRecipients: async (_db: unknown, input: unknown) => { calls.push({ target: "core", args: input }); return coreResult } },
  })
  ;({ updateChantier } = await import("@/lib/actions/chantier.actions"))
})
beforeEach(() => { calls.length = 0; coreResult = { ok: true, changed: true, diff: {} } })

function fd(extra: Record<string, string | string[]> = {}): FormData {
  const f = new FormData()
  const fields: Record<string, string | string[]> = { name: "Chantier test", clientId: "cl1", address: "1 rue A", startDate: "", endDate: "", dailyHours: "8", description: "", ...extra }
  for (const [k, v] of Object.entries(fields)) for (const item of Array.isArray(v) ? v : [v]) f.append(k, item)
  return f
}
const as = (role: string) => { session = { user: { id: `u-${role.toLowerCase()}`, role, companyId: "c1" } } }
const RECIPIENTS = JSON.stringify([{ label: "Responsable", email: "resp@client.example", active: true }])
const targets = () => calls.map((c) => c.target)

describe("updateChantier × destinataires des photos", () => {
  for (const role of ["ADMIN", "TEAM_LEADER"]) {
    it(`${role} fournissant le champ (même vide) ⇒ refus, AUCUNE lecture ni écriture`, async () => {
      as(role)
      for (const value of [RECIPIENTS, "[]", "invalide"]) {
        const result = await updateChantier("w1", fd({ photoRecipients: value }))
        assert.deepEqual(result, { error: "Seul un Super Admin peut modifier les destinataires des photos." })
      }
      assert.deepEqual(calls, [])
    })
  }
  it("EMPLOYEE : refus existant inchangé (Accès refusé), aucune écriture", async () => {
    as("EMPLOYEE")
    await assert.rejects(updateChantier("w1", fd({ photoRecipients: RECIPIENTS })), /Accès refusé/)
    assert.deepEqual(calls, [])
  })
  it("SUPER_ADMIN avec liste mal formée (doublon, répétée, JSON invalide) ⇒ refus, aucune lecture ni écriture", async () => {
    as("SUPER_ADMIN")
    const dup = JSON.stringify([{ email: "a@client.example", active: true }, { email: "A@client.example", active: true }])
    assert.match((await updateChantier("w1", fd({ photoRecipients: dup }))).error ?? "", /déjà présente/)
    assert.ok((await updateChantier("w1", fd({ photoRecipients: ["[]", "[]"] }))).error)
    assert.ok((await updateChantier("w1", fd({ photoRecipients: "{" }))).error)
    assert.deepEqual(calls, [])
  })
  for (const role of ["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"]) {
    it(`${role} sans le champ ⇒ écriture historique inchangée, destinataires non touchés`, async () => {
      as(role)
      const result = await updateChantier("w1", fd({ name: "Nom modifié" }))
      assert.deepEqual(result, { success: true })
      assert.deepEqual(targets().filter((t) => t !== "revalidate"), ["worksite.findFirst", "client.findFirst", "worksite.update"])
      const update = calls.find((c) => c.target === "worksite.update")!.args as { where: unknown; data: Record<string, unknown> }
      assert.deepEqual(update.where, { id: "w1" })
      assert.equal(update.data.name, "Nom modifié")
      assert.equal("clientContact" in update.data, false)
      assert.equal("photoRecipientsConfiguredAt" in update.data, false)
      assert.equal(update.data.startDate, null, "dates nullables préservées")
    })
  }
  it("SUPER_ADMIN avec la liste ⇒ cœur transactionnel seul (aucune écriture directe), géocodage avant", async () => {
    as("SUPER_ADMIN")
    const result = await updateChantier("w1", fd({ photoRecipients: RECIPIENTS, address: "2 rue B" }))
    assert.deepEqual(result, { success: true })
    assert.deepEqual(targets().filter((t) => t !== "revalidate"), ["worksite.findFirst", "client.findFirst", "geocode", "core"])
    const input = calls.find((c) => c.target === "core")!.args as { companyId: string; actorUserId: string; worksiteId: string; recipients: unknown; data: Record<string, unknown> }
    assert.equal(input.companyId, "c1")
    assert.equal(input.actorUserId, "u-super_admin")
    assert.deepEqual(input.recipients, [{ label: "Responsable", email: "resp@client.example", active: true }])
    assert.equal(input.data.latitude, 3)
  })
  it("refus du cœur (autorité révoquée, chantier hors entreprise) ⇒ message, aucune revalidation", async () => {
    as("SUPER_ADMIN")
    coreResult = { ok: false, code: "FORBIDDEN" }
    assert.deepEqual(await updateChantier("w1", fd({ photoRecipients: "[]" })), { error: "Seul un Super Admin peut modifier les destinataires des photos." })
    coreResult = { ok: false, code: "WORKSITE_NOT_FOUND" }
    assert.deepEqual(await updateChantier("w1", fd({ photoRecipients: "[]" })), { error: "Chantier introuvable." })
    assert.equal(targets().includes("revalidate"), false)
  })
})
