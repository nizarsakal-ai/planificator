/**
 * Lot 2b juridique : suppression de son compte, export « Mes données », page publique de demande.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import { authorizedCallback } from "@/auth.config"
import { anonymizedEmail, deleteOwnAccountImpl, type AccountDeletionDeps } from "@/lib/account/account-deletion.core"
import { buildPersonalDataExport, exportFileName, stripSensitive } from "@/lib/account/personal-data-export"
import { privacyContactEmail } from "@/lib/legal/legal-documents"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")

function deps(over: Partial<AccountDeletionDeps> & { role?: string; admins?: { id: string; name: string }[]; others?: number } = {}) {
  const calls: string[] = []
  const d: AccountDeletionDeps = {
    sessionUserId: async () => "u1",
    findAccount: async () => ({ id: "u1", role: over.role ?? "EMPLOYEE", passwordHash: "h", adminCompanies: over.admins ?? [] }),
    verifyPassword: async (p) => p === "bon",
    countOtherAdmins: async () => over.others ?? 0,
    anonymize: async (id) => { calls.push(id) },
    ...over,
  }
  return { d, calls }
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
  it("l'anonymisation désactive le compte, efface e-mail et nom, garde la fiche employé désactivée", () => {
    const src = readFileSync(join(ROOT, "src/lib/actions/account.actions.ts"), "utf8")
    const tx = src.slice(src.indexOf("prisma.$transaction"))
    assert.match(tx, /email: anonymizedEmail\(userId\), name: null, password: unusable, active: false/)
    assert.match(tx, /employee\.updateMany\(\{ where: \{ userId \}, data: \{ active: false, phone: null, avatarUrl: null \} \}\)/)
    assert.ok(!/employee\.delete/.test(tx), "la fiche employé n'est pas supprimée (données légales de l'employeur)")
    assert.match(tx, /historyLog\.create/)
  })
  it("une session ouverte est coupée : le rappel jwt refuse un compte inactif", () => {
    const src = readFileSync(join(ROOT, "src/auth.ts"), "utf8")
    assert.match(src, /if \(!dbUser \|\| !dbUser\.active\) return null/)
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
  it("n'exporte jamais mot de passe, jetons ni empreintes", () => {
    const json = JSON.stringify(buildPersonalDataExport(source))
    for (const k of ["password", "sha256", "uploadKey", "hash"]) assert.ok(!json.includes(k), k)
    assert.deepEqual(stripSensitive({ a: { token: "t", b: 1 } }), { a: { b: 1 } })
  })
  it("nom de fichier daté", () => {
    assert.equal(exportFileName(new Date("2026-11-25T10:00:00Z")), "planificator-mes-donnees-2026-11-25.json")
  })
  it("la route ne lit que les données du compte connecté", () => {
    const src = readFileSync(join(ROOT, "src/app/api/me/export/route.ts"), "utf8")
    assert.match(src, /status: 401/)
    assert.match(src, /where: \{ userId \}/)
    assert.match(src, /const byEmployee = \{ employeeId: \{ in: employeeIds \} \}/)
    assert.ok(!/password: true/.test(src))
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
  it("le profil propose l'export et la suppression, sauf au super-administrateur", () => {
    const src = readFileSync(join(ROOT, "src/app/(dashboard)/profil/page.tsx"), "utf8")
    assert.match(src, /session\.user\.role !== "SUPER_ADMIN" && <AccountDataCard \/>/)
    const card = readFileSync(join(ROOT, "src/components/profil/AccountDataCard.tsx"), "utf8")
    assert.match(card, /href="\/api\/me\/export"/)
    assert.match(card, /signOut\(/)
  })
})
