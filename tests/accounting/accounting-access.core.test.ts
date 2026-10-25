// COMPTABILITÉ LOT 0 — garde d'accès serveur (dépendances injectées : aucune DB, aucun next-auth).
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  ACCOUNTING_ALLOWED_ROLES,
  AccountingAccessError,
  accountingDenialDisposition,
  isAccountingNavVisible,
  requireAccountingAdminImpl,
  resolveAccountingAccess,
  type AccountingAccessDeps,
  type AccountingSessionLike,
} from "@/lib/accounting/access/accounting-access.core"

const CO_A = "company-a"
const CO_B = "company-b"

function makeDeps(opts: {
  enabled?: boolean
  session?: AccountingSessionLike | null
  companies?: Record<string, { id: string; active: boolean }>
  authThrows?: boolean
  findThrows?: boolean
  homes?: Record<string, string | null>
}) {
  const calls = { auth: 0, find: [] as string[] }
  const companies = opts.companies ?? { [CO_A]: { id: CO_A, active: true }, [CO_B]: { id: CO_B, active: true } }
  const deps: AccountingAccessDeps = {
    isModuleEnabled: () => opts.enabled ?? true,
    auth: async () => {
      calls.auth += 1
      if (opts.authThrows) throw new Error("auth down")
      return opts.session ?? null
    },
    findCompany: async (id) => {
      calls.find.push(id)
      if (opts.findThrows) throw new Error("db down")
      return companies[id] ?? null
    },
    findUserHomeCompanyId: async (userId) => (opts.homes ?? { "sa-galya": CO_A })[userId] ?? null,
  }
  return { deps, calls }
}

const session = (role: string | null, companyId: string | null, id: string | null = "u1"): AccountingSessionLike => ({
  user: { id, role, companyId },
})

describe("accounting access — feature flag", () => {
  it("flag OFF : refusé MODULE_DISABLED même pour un ADMIN valide, sans solliciter la session ni la base", async () => {
    const { deps, calls } = makeDeps({ enabled: false, session: session("ADMIN", CO_A) })
    assert.deepEqual(await resolveAccountingAccess(deps), { ok: false, reason: "MODULE_DISABLED" })
    assert.equal(calls.auth, 0)
    assert.deepEqual(calls.find, [])
  })

  it("flag OFF ⇒ 404 pour la page, sans aucune résolution de session ni de société", async () => {
    const { deps, calls } = makeDeps({ enabled: false, session: session("ADMIN", CO_A) })
    const result = await resolveAccountingAccess(deps)
    assert.deepEqual(result, { ok: false, reason: "MODULE_DISABLED" })
    assert.equal(calls.auth, 0)
    assert.deepEqual(calls.find, [])
    assert.equal(accountingDenialDisposition("MODULE_DISABLED"), "not-found")
  })

  it("un flag renvoyant autre chose que true est traité comme OFF (fail-closed)", async () => {
    const { deps } = makeDeps({ session: session("ADMIN", CO_A) })
    deps.isModuleEnabled = (() => "true") as unknown as () => boolean
    assert.deepEqual(await resolveAccountingAccess(deps), { ok: false, reason: "MODULE_DISABLED" })
  })
})

describe("accounting access — rôles", () => {
  it("ADMIN + société valide + flag ON : autorisé, contexte issu de la session", async () => {
    const { deps } = makeDeps({ session: session("ADMIN", CO_A, "admin-1") })
    assert.deepEqual(await resolveAccountingAccess(deps), {
      ok: true,
      context: { userId: "admin-1", role: "ADMIN", companyId: CO_A },
    })
  })

  for (const role of ["TEAM_LEADER", "EMPLOYEE", "CLIENT"]) {
    it(`${role} : refusé FORBIDDEN (même avec société valide et flag ON)`, async () => {
      const { deps, calls } = makeDeps({ session: session(role, CO_A) })
      assert.deepEqual(await resolveAccountingAccess(deps), { ok: false, reason: "FORBIDDEN" })
      assert.deepEqual(calls.find, [], "aucune lecture de société pour un rôle refusé")
    })
  }

  it("rôle inconnu, vide ou absent : refusé", async () => {
    for (const role of ["ROOT", "admin", "Admin", "", null, undefined as unknown as null]) {
      const { deps } = makeDeps({ session: session(role, CO_A) })
      assert.deepEqual(await resolveAccountingAccess(deps), { ok: false, reason: "FORBIDDEN" }, String(role))
    }
  })

  it("rôles autorisés : ADMIN et SUPER_ADMIN (ce dernier borné à sa société de rattachement)", () => {
    assert.deepEqual([...ACCOUNTING_ALLOWED_ROLES], ["ADMIN", "SUPER_ADMIN"])
  })

  it("non authentifié : UNAUTHENTICATED (session nulle, sans utilisateur, sans id, auth qui échoue)", async () => {
    for (const s of [null, {}, { user: null }, session("ADMIN", CO_A, null), session("ADMIN", CO_A, "  ")]) {
      const { deps } = makeDeps({ session: s })
      assert.deepEqual(await resolveAccountingAccess(deps), { ok: false, reason: "UNAUTHENTICATED" })
    }
    const { deps } = makeDeps({ session: session("ADMIN", CO_A), authThrows: true })
    assert.deepEqual(await resolveAccountingAccess(deps), { ok: false, reason: "UNAUTHENTICATED" })
  })
})

describe("accounting access — SUPER_ADMIN : uniquement sa société de rattachement (décision du 25/10/2026)", () => {
  it("SUPER_ADMIN dans sa société de rattachement (ex. Galya), active : autorisé", async () => {
    const { deps } = makeDeps({ session: session("SUPER_ADMIN", CO_A, "sa-galya") })
    assert.deepEqual(await resolveAccountingAccess(deps), { ok: true, context: { userId: "sa-galya", role: "SUPER_ADMIN", companyId: CO_A } })
  })

  it("SUPER_ADMIN dans une AUTRE société que la sienne : refusé (FORBIDDEN), avant toute lecture de société", async () => {
    const { deps, calls } = makeDeps({ session: session("SUPER_ADMIN", CO_B, "sa-galya") })
    assert.deepEqual(await resolveAccountingAccess(deps), { ok: false, reason: "FORBIDDEN" })
    assert.deepEqual(calls.find, [])
    await assert.rejects(() => requireAccountingAdminImpl(deps), (err: unknown) => err instanceof AccountingAccessError && err.reason === "FORBIDDEN")
  })

  it("SUPER_ADMIN sans société de rattachement, sans société de session, ou lecture en échec : refusé", async () => {
    const { deps: d1 } = makeDeps({ session: session("SUPER_ADMIN", CO_A, "sa-orphan"), homes: { "sa-orphan": null } })
    assert.deepEqual(await resolveAccountingAccess(d1), { ok: false, reason: "FORBIDDEN" })
    for (const companyId of [null, "", "   "]) {
      const { deps } = makeDeps({ session: session("SUPER_ADMIN", companyId, "sa-galya") })
      assert.deepEqual(await resolveAccountingAccess(deps), { ok: false, reason: "NO_COMPANY" }, String(companyId))
    }
    const { deps: d3 } = makeDeps({ session: session("SUPER_ADMIN", CO_A, "sa-galya") })
    d3.findUserHomeCompanyId = async () => { throw new Error("db down") }
    assert.deepEqual(await resolveAccountingAccess(d3), { ok: false, reason: "FORBIDDEN" })
  })

  it("SUPER_ADMIN dans sa société mais société inactive : refusé (COMPANY_UNAVAILABLE)", async () => {
    const { deps } = makeDeps({ session: session("SUPER_ADMIN", CO_A, "sa-galya"), companies: { [CO_A]: { id: CO_A, active: false } } })
    assert.deepEqual(await resolveAccountingAccess(deps), { ok: false, reason: "COMPANY_UNAVAILABLE" })
  })
})

describe("accounting access — société (ADMIN)", () => {
  it("ADMIN sans société : refusé NO_COMPANY", async () => {
    const { deps } = makeDeps({ session: session("ADMIN", null) })
    assert.deepEqual(await resolveAccountingAccess(deps), { ok: false, reason: "NO_COMPANY" })
  })

  it("société inexistante, inactive, incohérente ou erreur d'accès base : refusé (fail-closed)", async () => {
    const { deps: d1 } = makeDeps({ session: session("ADMIN", "ghost") })
    assert.deepEqual(await resolveAccountingAccess(d1), { ok: false, reason: "COMPANY_UNAVAILABLE" })
    const { deps: d2 } = makeDeps({ session: session("ADMIN", CO_A), companies: { [CO_A]: { id: CO_A, active: false } } })
    assert.deepEqual(await resolveAccountingAccess(d2), { ok: false, reason: "COMPANY_UNAVAILABLE" })
    const { deps: d3 } = makeDeps({ session: session("ADMIN", CO_A), companies: { [CO_A]: { id: CO_B, active: true } } })
    assert.deepEqual(await resolveAccountingAccess(d3), { ok: false, reason: "COMPANY_UNAVAILABLE" })
    const { deps: d4 } = makeDeps({ session: session("ADMIN", CO_A), findThrows: true })
    assert.deepEqual(await resolveAccountingAccess(d4), { ok: false, reason: "COMPANY_UNAVAILABLE" })
  })

  it("le companyId de la session est normalisé (trim) et c'est lui seul qui est validé", async () => {
    const { deps, calls } = makeDeps({ session: session("ADMIN", `  ${CO_A}  `) })
    const result = await resolveAccountingAccess(deps)
    assert.deepEqual(result, { ok: true, context: { userId: "u1", role: "ADMIN", companyId: CO_A } })
    assert.deepEqual(calls.find, [CO_A])
  })
})

describe("accounting access — tenant : aucune entrée client ne choisit la société", () => {
  it("un argument « client » supplémentaire est ignoré : companyId reste celui de la session", async () => {
    const { deps, calls } = makeDeps({ session: session("ADMIN", CO_A) })
    const forged = { companyId: CO_B, formData: { companyId: CO_B }, searchParams: { companyId: CO_B } }
    const loose = resolveAccountingAccess as unknown as (d: AccountingAccessDeps, input: unknown) => ReturnType<typeof resolveAccountingAccess>
    const result = await loose(deps, forged)
    assert.deepEqual(result, { ok: true, context: { userId: "u1", role: "ADMIN", companyId: CO_A } })
    assert.deepEqual(calls.find, [CO_A], "la société B n'est jamais lue ni validée")
  })

  it("même chose pour la variante « require » (Server Actions)", async () => {
    const { deps, calls } = makeDeps({ session: session("ADMIN", CO_A) })
    const loose = requireAccountingAdminImpl as unknown as (d: AccountingAccessDeps, input: unknown) => ReturnType<typeof requireAccountingAdminImpl>
    const context = await loose(deps, { companyId: CO_B })
    assert.equal(context.companyId, CO_A)
    assert.deepEqual(calls.find, [CO_A])
  })

  it("la garde ne déclare aucun paramètre d'entrée client (seulement les dépendances serveur)", () => {
    assert.equal(resolveAccountingAccess.length, 1)
    assert.equal(requireAccountingAdminImpl.length, 1)
  })
})

describe("accounting access — requireAccountingAdminImpl", () => {
  it("lève AccountingAccessError avec la raison, sans fuite de données", async () => {
    const { deps } = makeDeps({ session: session("EMPLOYEE", CO_A) })
    await assert.rejects(
      () => requireAccountingAdminImpl(deps),
      (err: unknown) => {
        assert.ok(err instanceof AccountingAccessError)
        assert.equal(err.reason, "FORBIDDEN")
        assert.equal(err.message, "ACCOUNTING_ACCESS_DENIED:FORBIDDEN")
        assert.ok(!String(err.message).includes(CO_A))
        return true
      }
    )
  })

  it("renvoie le contexte quand l'accès est accordé", async () => {
    const { deps } = makeDeps({ session: session("ADMIN", CO_A, "adm") })
    assert.deepEqual(await requireAccountingAdminImpl(deps), { userId: "adm", role: "ADMIN", companyId: CO_A })
  })
})

describe("accounting access — réaction des pages et visibilité du menu", () => {
  it("non connecté → /login ; module désactivé → 404 ; autres refus → /dashboard", () => {
    assert.equal(accountingDenialDisposition("UNAUTHENTICATED"), "login")
    assert.equal(accountingDenialDisposition("MODULE_DISABLED"), "not-found")
    for (const r of ["FORBIDDEN", "NO_COMPANY", "COMPANY_UNAVAILABLE"] as const) {
      assert.equal(accountingDenialDisposition(r), "dashboard", r)
    }
  })

  it("lien de menu visible seulement : flag ON + rôle ADMIN ou SUPER_ADMIN + société (affichage, la garde borne le SUPER_ADMIN)", () => {
    assert.equal(isAccountingNavVisible({ enabled: true, role: "ADMIN", companyId: CO_A }), true)
    assert.equal(isAccountingNavVisible({ enabled: true, role: "SUPER_ADMIN", companyId: CO_A }), true)
    assert.equal(isAccountingNavVisible({ enabled: true, role: "SUPER_ADMIN", companyId: null }), false)
    assert.equal(isAccountingNavVisible({ enabled: false, role: "ADMIN", companyId: CO_A }), false)
    assert.equal(isAccountingNavVisible({ enabled: true, role: "ADMIN", companyId: "  " }), false)
    for (const role of ["TEAM_LEADER", "EMPLOYEE", "CLIENT", "UNKNOWN", null, undefined]) {
      assert.equal(isAccountingNavVisible({ enabled: true, role, companyId: CO_A }), false, String(role))
    }
  })
})
