/**
 * PLAN-SECURITY-HOTFIX-001 LOT 1 — deleteEmploye, invitations, cron, OAuth Gmail.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"
process.env.RESEND_API_KEY ??= "re_test_dummy_for_unit"

import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, it } from "node:test"
import {
  deleteEmployeImpl,
  type DeleteEmployeDeps,
} from "@/lib/actions/employe-delete.core"
import {
  inviterMembreImpl,
  rolesAllowedForInviter,
  type InviterMembreDeps,
} from "@/lib/actions/invitation-invite.core"
import { assertCronBearerAuth } from "@/lib/cron/assert-cron-bearer-auth"
import { handleAcquisitionGmailSyncCron } from "@/lib/acquisition/connector/acquisition-gmail-sync.handler"
import { GET as chantiersCronGet } from "@/app/api/cron/chantiers/route"
import {
  resolveGmailOAuthHmacSecret,
  signGmailOAuthPayload,
  verifyGmailOAuthSignature,
} from "@/lib/auth/gmail-oauth-state"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")
const SECRET = "security-hotfix-cron-secret"

function inviteFd(email: string, role: string) {
  const fd = new FormData()
  fd.set("email", email)
  fd.set("role", role)
  return fd
}

describe("deleteEmployeImpl — tenant-safe", () => {
  function makeDeps(over: Partial<DeleteEmployeDeps> & {
    companyId?: string
    role?: string
    employee?: { id: string; userId: string } | null
  } = {}) {
    const calls = {
      find: [] as { id: string; companyId: string }[],
      deleteAssignments: [] as string[],
      deleteEmployee: [] as string[],
      deleteUser: [] as string[],
    }
    const companyId = over.companyId ?? "co-a"
    const role = over.role ?? "ADMIN"
    const employee =
      over.employee === undefined
        ? { id: "emp-1", userId: "user-1" }
        : over.employee

    const deps: DeleteEmployeDeps = {
      requireSession: async () => ({ companyId, role }),
      findEmployee: async (args) => {
        calls.find.push(args)
        if (!employee) return null
        if (args.id !== employee.id || args.companyId !== companyId) return null
        return employee
      },
      deleteAssignments: async (id) => {
        calls.deleteAssignments.push(id)
      },
      deleteEmployee: async (id) => {
        calls.deleteEmployee.push(id)
      },
      deleteUser: async (id) => {
        calls.deleteUser.push(id)
      },
      revalidate: () => {},
      ...over,
    }
    return { deps, calls }
  }

  it("ADMIN même tenant → suppression réussie", async () => {
    const { deps, calls } = makeDeps({ role: "ADMIN" })
    const r = await deleteEmployeImpl("emp-1", deps)
    assert.deepEqual(r, { success: true })
    assert.deepEqual(calls.find, [{ id: "emp-1", companyId: "co-a" }])
    assert.deepEqual(calls.deleteAssignments, ["emp-1"])
    assert.deepEqual(calls.deleteEmployee, ["emp-1"])
    assert.deepEqual(calls.deleteUser, ["user-1"])
  })

  it("TEAM_LEADER même tenant → comportement historique (succès)", async () => {
    const { deps, calls } = makeDeps({ role: "TEAM_LEADER" })
    const r = await deleteEmployeImpl("emp-1", deps)
    assert.deepEqual(r, { success: true })
    assert.equal(calls.deleteEmployee.length, 1)
  })

  it("employé autre tenant → refus, aucune suppression", async () => {
    const { deps, calls } = makeDeps({
      companyId: "co-a",
      findEmployee: async (args) => {
        calls.find.push(args)
        // Simule DB : employé existe ailleurs → findFirst id+companyId = null
        return null
      },
    })
    const r = await deleteEmployeImpl("emp-other-tenant", deps)
    assert.deepEqual(r, { error: "Employé introuvable" })
    assert.deepEqual(calls.find, [{ id: "emp-other-tenant", companyId: "co-a" }])
    assert.equal(calls.deleteAssignments.length, 0)
    assert.equal(calls.deleteEmployee.length, 0)
    assert.equal(calls.deleteUser.length, 0)
  })

  it("employé introuvable → erreur générique", async () => {
    const { deps, calls } = makeDeps({ employee: null })
    const r = await deleteEmployeImpl("missing", deps)
    assert.deepEqual(r, { error: "Employé introuvable" })
    assert.equal(calls.deleteEmployee.length, 0)
  })
})

describe("invitations — rôles", () => {
  it("matrice rolesAllowedForInviter", () => {
    assert.deepEqual(rolesAllowedForInviter("ADMIN"), [
      "ADMIN",
      "TEAM_LEADER",
      "EMPLOYEE",
    ])
    assert.deepEqual(rolesAllowedForInviter("SUPER_ADMIN"), [
      "ADMIN",
      "TEAM_LEADER",
      "EMPLOYEE",
    ])
    assert.deepEqual(rolesAllowedForInviter("TEAM_LEADER"), [
      "TEAM_LEADER",
      "EMPLOYEE",
    ])
    assert.deepEqual(rolesAllowedForInviter("EMPLOYEE"), [])
  })

  function makeInviteDeps(role: string) {
    const created: unknown[] = []
    const deps: InviterMembreDeps = {
      requireSession: async () => ({
        id: "u1",
        role,
        companyId: "co1",
        name: "Inviteur",
        email: "inviteur@test.fr",
      }),
      findExistingUser: async () => null,
      deleteUser: async () => {},
      deletePendingInvitations: async () => {},
      findCompanyName: async () => "Co",
      createInvitation: async (data) => {
        created.push(data)
      },
      revalidate: () => {},
      randomToken: () => "tok-fixed",
      now: () => new Date("2026-07-31T12:00:00.000Z"),
    }
    return { deps, created }
  }

  it("ADMIN invite ADMIN → succès", async () => {
    const { deps, created } = makeInviteDeps("ADMIN")
    const r = await inviterMembreImpl(inviteFd("a@test.fr", "ADMIN"), deps)
    assert.equal(r.success, true)
    assert.equal(created.length, 1)
    assert.equal((created[0] as { role: string }).role, "ADMIN")
  })

  it("ADMIN invite TEAM_LEADER / EMPLOYEE → succès", async () => {
    for (const role of ["TEAM_LEADER", "EMPLOYEE"] as const) {
      const { deps, created } = makeInviteDeps("ADMIN")
      const r = await inviterMembreImpl(inviteFd(`${role}@test.fr`, role), deps)
      assert.equal(r.success, true)
      assert.equal(created.length, 1)
    }
  })

  it("TEAM_LEADER invite ADMIN → refus, aucune invitation", async () => {
    const { deps, created } = makeInviteDeps("TEAM_LEADER")
    const r = await inviterMembreImpl(inviteFd("evil@test.fr", "ADMIN"), deps)
    assert.deepEqual(r, { error: "Accès refusé" })
    assert.equal(created.length, 0)
  })

  it("TEAM_LEADER invite EMPLOYEE / TEAM_LEADER → succès", async () => {
    for (const role of ["EMPLOYEE", "TEAM_LEADER"] as const) {
      const { deps, created } = makeInviteDeps("TEAM_LEADER")
      const r = await inviterMembreImpl(inviteFd(`${role}@x.fr`, role), deps)
      assert.equal(r.success, true)
      assert.equal(created.length, 1)
    }
  })

  it("EMPLOYEE (non autorisé) → throw Accès refusé", async () => {
    const { deps, created } = makeInviteDeps("EMPLOYEE")
    await assert.rejects(
      () => inviterMembreImpl(inviteFd("x@test.fr", "EMPLOYEE"), deps),
      /Accès refusé/
    )
    assert.equal(created.length, 0)
  })
})

describe("cron fail-closed — routes hotfix", () => {
  const prev = process.env.CRON_SECRET

  afterEach(() => {
    if (prev === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = prev
  })

  it("chantiers : Bearer undefined → 401 (secret unset)", async () => {
    delete process.env.CRON_SECRET
    const res = await chantiersCronGet(
      new Request("http://localhost/api/cron/chantiers", {
        headers: { authorization: "Bearer undefined" },
      })
    )
    assert.equal(res.status, 401)
  })

  it("acquisition-gmail-sync : Bearer undefined → 401", async () => {
    delete process.env.CRON_SECRET
    const res = await handleAcquisitionGmailSyncCron(
      new Request("http://localhost/api/cron/acquisition-gmail-sync", {
        headers: { authorization: "Bearer undefined" },
      })
    )
    assert.equal(res.status, 401)
  })

  it("assertCronBearerAuth bon secret → null", () => {
    process.env.CRON_SECRET = SECRET
    assert.equal(
      assertCronBearerAuth(
        new Request("http://x", { headers: { authorization: `Bearer ${SECRET}` } })
      ),
      null
    )
  })
})

describe("gmail OAuth state — no fallback", () => {
  const prev = process.env.CRON_SECRET

  afterEach(() => {
    if (prev === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = prev
  })

  it("secret absent → null", () => {
    delete process.env.CRON_SECRET
    assert.equal(resolveGmailOAuthHmacSecret(), null)
  })

  it('secret "undefined" → null', () => {
    process.env.CRON_SECRET = "undefined"
    assert.equal(resolveGmailOAuthHmacSecret(), null)
  })

  it("signature valide avec secret → acceptée", () => {
    process.env.CRON_SECRET = SECRET
    const secret = resolveGmailOAuthHmacSecret()!
    const payload = JSON.stringify({ companyId: "c1", userId: "u1", nonce: 1 })
    const sig = signGmailOAuthPayload(payload, secret)
    assert.equal(verifyGmailOAuthSignature(payload, sig, secret), true)
  })

  it("signature forgée → refus", () => {
    process.env.CRON_SECRET = SECRET
    const secret = resolveGmailOAuthHmacSecret()!
    const payload = JSON.stringify({ companyId: "c1", userId: "u1", nonce: 1 })
    assert.equal(
      verifyGmailOAuthSignature(payload, "ab".repeat(32), secret),
      false
    )
    assert.equal(
      verifyGmailOAuthSignature(payload, signGmailOAuthPayload(payload, "other"), secret),
      false
    )
  })

  it('aucune occurrence "fallback" dans routes Gmail / helper', () => {
    for (const rel of [
      "src/app/api/auth/gmail/route.ts",
      "src/app/api/auth/gmail/callback/route.ts",
      "src/lib/auth/gmail-oauth-state.ts",
    ]) {
      const src = readFileSync(join(ROOT, rel), "utf8")
      assert.equal(src.includes('"fallback"'), false, rel)
      assert.equal(src.includes("'fallback'"), false, rel)
    }
  })

  it("routes cron modifiées n’utilisent plus Bearer inline", () => {
    const files = [
      "src/app/api/cron/chantiers/route.ts",
      "src/app/api/admin/cleanup-past/route.ts",
      "src/lib/acquisition/connector/acquisition-gmail-sync.handler.ts",
      "src/lib/acquisition/attachments/attachment-download-cron.handler.ts",
      "src/lib/acquisition/attachments/attachment-recovery-cron.handler.ts",
      "src/lib/acquisition/content/message-content-cron.handler.ts",
      "src/lib/acquisition/extraction/extraction-cron.handler.ts",
      "src/lib/acquisition/orchestrator/acquisition-orchestrator.handler.ts",
    ]
    for (const rel of files) {
      assert.equal(existsSync(join(ROOT, rel)), true, rel)
      const src = readFileSync(join(ROOT, rel), "utf8")
      assert.equal(
        src.includes("Bearer ${process.env.CRON_SECRET}"),
        false,
        rel
      )
      assert.match(src, /assertCronBearerAuth/)
    }
  })
})
