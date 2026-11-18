import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { ACCESS_LINK_TTL_MS, resendAccessForEmployee, type AccessTarget, type ResendAccessDeps } from "../../src/lib/actions/employe-access.core"

// Données synthétiques uniquement. Renvoi de l'accès depuis la fiche d'UN salarié.
const NOW = new Date("2026-11-18T10:00:00Z")
const emp = (o: Partial<AccessTarget> = {}): AccessTarget => ({ id: "e1", firstName: "Alex", active: true,
  user: { id: "u1", email: "alex@exemple.fr", active: true }, ...o })
function deps(found: AccessTarget | null) {
  const calls = { find: [] as [string, string][], tokens: [] as [string, string, Date][], mails: [] as unknown[] }
  const d: ResendAccessDeps = {
    findEmployee: async (id, companyId) => { calls.find.push([id, companyId]); return found },
    companyName: async () => "Entreprise test",
    replaceResetToken: async (userId, token, exp) => { calls.tokens.push([userId, token, exp]) },
    sendWelcomeEmail: async (a) => { calls.mails.push(a) },
    newToken: () => "tok", now: () => NOW,
  }
  return { d, calls }
}

describe("renvoi de l'accès à un seul salarié", () => {
  it("un seul e-mail, au seul salarié demandé, recherché dans l'entreprise de la session", async () => {
    const { d, calls } = deps(emp())
    assert.deepEqual(await resendAccessForEmployee(d, "c1", "e1"), { success: true, email: "alex@exemple.fr" })
    assert.deepEqual(calls.find, [["e1", "c1"]])
    assert.deepEqual(calls.tokens, [["u1", "tok", new Date(NOW.getTime() + ACCESS_LINK_TTL_MS)]])
    assert.deepEqual(calls.mails, [{ to: "alex@exemple.fr", token: "tok", employeeName: "Alex", companyName: "Entreprise test" }])
  })
  it("salarié d'une autre entreprise ou identifiant invalide : refus, rien n'est envoyé", async () => {
    for (const id of ["e-autre", "../x", ""]) {
      const { d, calls } = deps(null)
      assert.deepEqual(await resendAccessForEmployee(d, "c1", id), { success: false, error: "Employé introuvable." })
      assert.equal(calls.mails.length + calls.tokens.length, 0)
    }
  })
  it("fiche à compléter, salarié désactivé ou compte jamais activé : message explicite, rien n'est envoyé", async () => {
    const cases: [AccessTarget, RegExp][] = [
      [emp({ user: { id: "u1", email: "rh-fiche-x@fiche-a-completer.invalid", active: false } }), /Fiche à compléter/],
      [emp({ active: false }), /Salarié désactivé/],
      [emp({ user: { id: "u1", email: "alex@exemple.fr", active: false } }), /invitation non acceptée/],
    ]
    for (const [target, message] of cases) {
      const { d, calls } = deps(target)
      const r = await resendAccessForEmployee(d, "c1", "e1")
      assert.equal(r.success, false); assert.match(!r.success ? r.error : "", message)
      assert.equal(calls.mails.length + calls.tokens.length, 0)
    }
  })
  it("le renvoi groupé existant est conservé ; la fiche employé propose le renvoi individuel aux administrateurs", () => {
    const actions = readFileSync("src/lib/actions/employe.actions.ts", "utf8")
    assert.match(actions, /export async function resendAccessEmails\(\)/)
    assert.match(actions, /export async function resendEmployeeAccessEmail\(employeeId: string\)/)
    assert.match(readFileSync("src/app/(dashboard)/employes/page.tsx", "utf8"), /<ResendAccessButton \/>/)
    const page = readFileSync("src/app/(dashboard)/employes/[id]/page.tsx", "utf8")
    assert.match(page, /\{isAdmin && \(\s*<div className="mt-3 flex flex-col gap-1">\s*<ResendEmployeeAccessButton employeeId=\{employee\.id\}/)
  })
})
