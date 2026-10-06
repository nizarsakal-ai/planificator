// VEHICLES V1B-db — réinvitation d'un employé archivé : identité préservée (aucune connexion DB).
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { acceptInvitationImpl, type AcceptInvitationDeps, type AcceptableInvitation } from "@/lib/actions/invitation-accept.core"
import {
  INVITE_ACCOUNT_AMBIGUOUS,
  inviterMembreImpl,
  isReactivableArchivedMember,
  type ExistingMember,
  type InviterMembreDeps,
} from "@/lib/actions/invitation-invite.core"

const archived = (over: Partial<ExistingMember> = {}): ExistingMember => ({
  id: "user-1",
  active: false,
  role: "EMPLOYEE",
  companyId: "co-a",
  employeeProfile: { id: "emp-1", active: false, companyId: "co-a" },
  ...over,
})

const fd = (o: Record<string, string>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(o)) f.set(k, v)
  return f
}

function inviteSetup(existing: ExistingMember | null) {
  const log: string[] = []
  const deps: InviterMembreDeps = {
    requireSession: async () => ({ id: "admin", role: "ADMIN", companyId: "co-a" }),
    findExistingUser: async () => existing,
    deletePendingInvitations: async () => {
      log.push("deletePending")
    },
    findCompanyName: async () => "Co",
    createInvitation: async () => {
      log.push("createInvitation")
    },
    revalidate: () => {},
    randomToken: () => "tok",
    now: () => new Date("2026-10-06T10:00:00Z"),
  }
  // Garde-fou : le contrat n'expose plus aucune suppression de User.
  assert.ok(!("deleteUser" in deps))
  return { deps, log }
}

describe("inviterMembre — identité existante", () => {
  const invite = (deps: InviterMembreDeps) => inviterMembreImpl(fd({ email: "a@x.fr", role: "EMPLOYEE" }), deps)

  it("employé archivé même entreprise → invitation créée, aucune suppression", async () => {
    const { deps, log } = inviteSetup(archived())
    const r = await invite(deps)
    assert.equal(r.success, true)
    assert.deepEqual(log, ["deletePending", "createInvitation"])
  })

  it("employé actif → refus historique", async () => {
    const { deps, log } = inviteSetup(archived({ active: true, employeeProfile: { id: "emp-1", active: true, companyId: "co-a" } }))
    assert.deepEqual(await invite(deps), { error: "Cet employé fait déjà partie de votre entreprise." })
    assert.deepEqual(log, [])
  })

  for (const [label, existing] of [
    ["User sans Employee", archived({ employeeProfile: null })],
    ["Employee d'une autre entreprise", archived({ employeeProfile: { id: "emp-1", active: false, companyId: "co-b" } })],
    ["User d'une autre entreprise", archived({ companyId: "co-b" })],
    ["User actif / Employee inactif", archived({ active: true })],
    ["rôle ADMIN (pas d'écrasement)", archived({ role: "ADMIN" })],
  ] as const) {
    it(`état ambigu (${label}) → refus contrôlé, aucune écriture`, async () => {
      const { deps, log } = inviteSetup(existing)
      const r = (await invite(deps)) as { code?: string; error?: string }
      assert.equal(r.code, INVITE_ACCOUNT_AMBIGUOUS)
      assert.ok(r.error && !/prisma|postgres|P20/i.test(r.error))
      assert.deepEqual(log, [])
    })
  }

  it("invitation ordinaire (aucun compte) inchangée", async () => {
    const { deps, log } = inviteSetup(null)
    const r = await invite(deps)
    assert.equal(r.success, true)
    assert.deepEqual(log, ["deletePending", "createInvitation"])
  })

  it("isReactivableArchivedMember", () => {
    assert.equal(isReactivableArchivedMember(archived(), "co-a"), true)
    assert.equal(isReactivableArchivedMember(archived(), "co-b"), false)
  })

  it("aucun deleteUser dans les actions d'invitation", async () => {
    const { readFileSync } = await import("node:fs")
    for (const f of ["invitation.actions.ts", "invitation-invite.core.ts", "invitation-accept.core.ts"]) {
      assert.ok(!/deleteUser|user\.delete\(/.test(readFileSync(`src/lib/actions/${f}`, "utf8")), f)
    }
  })
})

describe("acceptInvitation — réactivation", () => {
  const invitation: AcceptableInvitation = { id: "inv-1", email: "a@x.fr", role: "EMPLOYEE", companyId: "co-a" }
  const form = () => fd({ token: "tok", name: "Jean Dupont", password: "motdepasse1" })

  function acceptSetup(existing: ExistingMember | null, over: Partial<AcceptInvitationDeps> = {}) {
    const log: unknown[] = []
    const deps: AcceptInvitationDeps = {
      findInvitation: async () => invitation,
      findUserByEmail: async () => existing,
      hashPassword: async (p) => `hash(${p})`,
      createMember: async (a) => {
        log.push(["create", a.password])
      },
      reactivateMember: async (a) => {
        log.push(["reactivate", a])
        return true
      },
      ...over,
    }
    return { deps, log }
  }

  it("employé archivé même entreprise → mêmes IDs User/Employee, aucune création", async () => {
    const { deps, log } = acceptSetup(archived())
    assert.deepEqual(await acceptInvitationImpl(form(), deps), { success: true })
    assert.equal(log.length, 1)
    const [kind, args] = log[0] as [string, Record<string, unknown>]
    assert.equal(kind, "reactivate")
    assert.deepEqual(args, {
      invitationId: "inv-1",
      userId: "user-1",
      employeeId: "emp-1",
      companyId: "co-a",
      role: "EMPLOYEE",
      name: "Jean Dupont",
      password: "hash(motdepasse1)",
    })
  })

  it("compte d'une autre entreprise → refus historique, aucune écriture", async () => {
    const { deps, log } = acceptSetup(archived({ companyId: "co-b" }))
    assert.deepEqual(await acceptInvitationImpl(form(), deps), { error: "Un compte existe déjà avec cet email." })
    assert.deepEqual(log, [])
  })

  it("état ambigu même entreprise → refus contrôlé, aucune écriture", async () => {
    for (const e of [archived({ employeeProfile: null }), archived({ active: true }), archived({ employeeProfile: { id: "emp-1", active: true, companyId: "co-a" } })]) {
      const { deps, log } = acceptSetup(e)
      const r = (await acceptInvitationImpl(form(), deps)) as { code?: string }
      assert.equal(r.code, INVITE_ACCOUNT_AMBIGUOUS)
      assert.deepEqual(log, [])
    }
  })

  it("état changé entre lecture et écriture (réactivation refusée) → refus contrôlé", async () => {
    const { deps } = acceptSetup(archived(), { reactivateMember: async () => false })
    const r = (await acceptInvitationImpl(form(), deps)) as { code?: string }
    assert.equal(r.code, INVITE_ACCOUNT_AMBIGUOUS)
  })

  it("aucun compte → création inchangée", async () => {
    const { deps, log } = acceptSetup(null)
    assert.deepEqual(await acceptInvitationImpl(form(), deps), { success: true })
    assert.deepEqual(log, [["create", "hash(motdepasse1)"]])
  })

  it("invitation invalide / payload invalide inchangés", async () => {
    assert.deepEqual(await acceptInvitationImpl(form(), acceptSetup(null, { findInvitation: async () => null }).deps), { error: "Invitation invalide ou expirée." })
    assert.deepEqual(await acceptInvitationImpl(fd({ token: "t", name: "N", password: "court" }), acceptSetup(null).deps), { error: "8 caractères minimum" })
  })

  it("câblage : réactivation transactionnelle gardée (updateMany active:false, même company), IDs jamais recréés", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("src/lib/actions/invitation.actions.ts", "utf8")
    const fn = src.slice(src.indexOf("reactivateMember:"))
    assert.ok(/prisma\.\$transaction/.test(fn))
    assert.ok(/tx\.user\.updateMany\(\{\s*where: \{ id: userId, companyId, active: false \}/.test(fn))
    assert.ok(/tx\.employee\.updateMany\(\{\s*where: \{ id: employeeId, userId, companyId, active: false \}/.test(fn))
    assert.ok(!/employee\.create|user\.create/.test(fn.slice(0, fn.indexOf("class IdentityStateChanged"))))
  })
})
