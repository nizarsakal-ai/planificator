/**
 * Lot 2b juridique : suppression de son compte, export « Mes données », page publique de demande.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { authorizedCallback } from "@/auth.config"
import { anonymizedEmail, cloudinaryPublicIdFromUrl, deleteOwnAccountImpl, type AccountDeletionDeps } from "@/lib/account/account-deletion.core"
import { buildPersonalDataExport, exportFileName, stripSensitive } from "@/lib/account/personal-data-export"
import { privacyContactEmail } from "@/lib/legal/legal-documents"

function deps(over: Partial<AccountDeletionDeps> & { role?: string; admins?: { id: string; name: string }[]; others?: number; avatars?: string[] } = {}) {
  const calls: string[] = []
  const deleted: string[][] = []
  const d: AccountDeletionDeps = {
    sessionUserId: async () => "u1",
    findAccount: async () => ({ id: "u1", role: over.role ?? "EMPLOYEE", passwordHash: "h", adminCompanies: over.admins ?? [] }),
    verifyPassword: async (p) => p === "bon",
    countOtherAdmins: async () => over.others ?? 0,
    anonymize: async (id) => { calls.push(id); return { ok: true, avatarUrls: over.avatars ?? [] } },
    deleteAvatars: async (urls) => { deleted.push(urls) },
    ...over,
  }
  return { d, calls, deleted }
}
const ok = { password: "bon", confirmation: "SUPPRIMER" }

describe("suppression de son compte", () => {
  it("un salarié supprime son compte avec mot de passe et confirmation", async () => {
    const { d, calls } = deps()
    assert.deepEqual(await deleteOwnAccountImpl(ok, d), { ok: true })
    assert.deepEqual(calls, ["u1"])
  })
  it("la confirmation tolère minuscules et espaces", async () => {
    const { d } = deps()
    assert.deepEqual(await deleteOwnAccountImpl({ password: "bon", confirmation: " supprimer " }, d), { ok: true })
  })
  it("refuse sans session", async () => {
    const { d, calls } = deps({ sessionUserId: async () => null })
    const r = await deleteOwnAccountImpl(ok, d)
    assert.equal(r.ok, false); if (!r.ok) assert.equal(r.code, "UNAUTHENTICATED")
    assert.equal(calls.length, 0)
  })
  it("refuse un mauvais mot de passe, sans rien effacer", async () => {
    const { d, calls } = deps()
    const r = await deleteOwnAccountImpl({ password: "faux", confirmation: "SUPPRIMER" }, d)
    assert.equal(r.ok, false); if (!r.ok) assert.equal(r.code, "BAD_PASSWORD")
    assert.equal(calls.length, 0)
  })
  it("refuse sans le mot de confirmation, avant même de vérifier le mot de passe", async () => {
    let checked = false
    const { d, calls } = deps({ verifyPassword: async () => { checked = true; return true } })
    const r = await deleteOwnAccountImpl({ password: "bon", confirmation: "oui" }, d)
    assert.equal(r.ok, false); if (!r.ok) assert.equal(r.code, "INVALID_CONFIRMATION")
    assert.equal(checked, false); assert.equal(calls.length, 0)
  })
  it("refuse le super-administrateur", async () => {
    const { d, calls } = deps({ role: "SUPER_ADMIN" })
    const r = await deleteOwnAccountImpl(ok, d)
    assert.equal(r.ok, false); if (!r.ok) assert.equal(r.code, "SUPER_ADMIN")
    assert.equal(calls.length, 0)
  })
  it("bloque le dernier administrateur d'une société et la nomme", async () => {
    const { d, calls } = deps({ role: "ADMIN", admins: [{ id: "c1", name: "GALYA EVENTS" }], others: 0 })
    const r = await deleteOwnAccountImpl(ok, d)
    assert.equal(r.ok, false)
    if (!r.ok) { assert.equal(r.code, "LAST_ADMIN"); assert.deepEqual(r.companies, ["GALYA EVENTS"]); assert.match(r.error, /GALYA EVENTS/) }
    assert.equal(calls.length, 0)
  })
  it("autorise un administrateur quand un autre administrateur reste", async () => {
    const { d, calls } = deps({ role: "ADMIN", admins: [{ id: "c1", name: "A" }], others: 1 })
    assert.deepEqual(await deleteOwnAccountImpl(ok, d), { ok: true })
    assert.deepEqual(calls, ["u1"])
  })
  it("une erreur de base donne un message neutre", async () => {
    const { d } = deps({ anonymize: async () => { throw new Error("db") } })
    const r = await deleteOwnAccountImpl(ok, d)
    assert.equal(r.ok, false); if (!r.ok) assert.equal(r.code, "ERROR")
  })
  it("l'adresse de remplacement ne contient aucune donnée personnelle", () => {
    assert.equal(anonymizedEmail("abc"), "compte-supprime-abc@supprime.invalid")
  })
  it("le recompte sous verrou l'emporte sur le pré-contrôle : rien n'est supprimé", async () => {
    const { d } = deps({ role: "ADMIN", admins: [{ id: "c1", name: "A" }], others: 1, anonymize: async () => ({ ok: false, lastAdminCompanies: ["A"] }) })
    const r = await deleteOwnAccountImpl(ok, d)
    assert.equal(r.ok, false); if (!r.ok) { assert.equal(r.code, "LAST_ADMIN"); assert.deepEqual(r.companies, ["A"]) }
  })
  it("efface la photo de profil après la suppression", async () => {
    const { d, deleted } = deps({ avatars: ["https://res.cloudinary.com/x/image/upload/v1/planificator/c1/avatars/employee-e1.jpg"] })
    assert.deepEqual(await deleteOwnAccountImpl(ok, d), { ok: true })
    assert.equal(deleted.length, 1)
  })
  it("un échec chez l'hébergeur de la photo ne fait pas échouer la suppression du compte", async () => {
    const { d } = deps({ avatars: ["https://res.cloudinary.com/x/image/upload/v1/a.jpg"], deleteAvatars: async () => { throw new Error("réseau") } })
    assert.deepEqual(await deleteOwnAccountImpl(ok, d), { ok: true })
  })
  it("identifiant Cloudinary tiré de l'adresse, jamais d'une adresse étrangère", () => {
    assert.equal(cloudinaryPublicIdFromUrl("https://res.cloudinary.com/demo/image/upload/v1732/planificator/c1/avatars/employee-e1.jpg"), "planificator/c1/avatars/employee-e1")
    assert.equal(cloudinaryPublicIdFromUrl("https://res.cloudinary.com/demo/image/upload/c_fill,w_300/v1732/a/b.png"), "a/b")
    assert.equal(cloudinaryPublicIdFromUrl("https://exemple.fr/image/upload/v1/a.jpg"), null)
    assert.equal(cloudinaryPublicIdFromUrl("pas une url"), null)
    assert.equal(cloudinaryPublicIdFromUrl(null), null)
  })
})

describe("export « Mes données »", () => {
  const source = {
    user: { id: "u1", email: "a@b.fr", name: "A", role: "EMPLOYEE", createdAt: new Date("2026-01-01T00:00:00Z"), lastLoginAt: null, password: "hash" },
    employees: [{ firstName: "A", company: { name: "Soc" } }],
    timeclocks: [{ date: new Date("2026-11-01T00:00:00Z"), checkInLat: 48.8 }],
    absences: [], expenseReports: [], assignments: [], hrDocuments: [{ title: "Bulletin", sha256: "x", uploadKey: "k" }], notifications: [],
  }
  it("contient le compte et les données, dates en ISO", () => {
    const out = buildPersonalDataExport(source, new Date("2026-11-25T10:00:00Z"))
    assert.equal(out.application, "Planificator")
    assert.equal(out.exportedAt, "2026-11-25T10:00:00.000Z")
    assert.deepEqual((out.compte as Record<string, unknown>).email, "a@b.fr")
    assert.deepEqual(out.pointages, [{ date: "2026-11-01T00:00:00.000Z", checkInLat: 48.8 }])
  })
  it("retire aussi les clés qui contiennent un mot sensible (passwordHash, tokenHash…)", () => {
    assert.deepEqual(stripSensitive({ passwordHash: "x", tokenHash: "y", accessTokenExpiresAt: 1, apiKeyId: 2, nom: "ok" }), { nom: "ok" })
  })
  it("n'exporte jamais mot de passe, jetons ni empreintes", () => {
    const json = JSON.stringify(buildPersonalDataExport(source))
    for (const k of ["password", "sha256", "uploadKey", "hash"]) assert.ok(!json.includes(k), k)
    assert.deepEqual(stripSensitive({ a: { token: "t", b: 1 } }), { a: { b: 1 } })
  })
  it("nom de fichier daté", () => {
    assert.equal(exportFileName(new Date("2026-11-25T10:00:00Z")), "planificator-mes-donnees-2026-11-25.json")
  })
})

describe("page publique de demande de suppression", () => {
  it("/suppression-compte est publique, connecté ou non", () => {
    const req = { nextUrl: new URL("http://localhost/suppression-compte") }
    assert.equal(authorizedCallback({ auth: null, request: req }), true)
    assert.equal(authorizedCallback({ auth: { user: { role: "EMPLOYEE" } }, request: req }), true)
  })
  it("adresse de contact : seulement si configurée et valide", () => {
    assert.equal(privacyContactEmail({}), null)
    assert.equal(privacyContactEmail({ NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL: "pas-une-adresse" }), null)
    assert.equal(privacyContactEmail({ NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL: " rgpd@galyaevents.fr " }), "rgpd@galyaevents.fr")
  })
})
