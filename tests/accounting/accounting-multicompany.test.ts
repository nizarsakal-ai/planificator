// COMPTABILITÉ LOT 0 — intégration avec le modèle multi-société de main (65e314b) :
// la session porte le rôle et la société ACTIVE résolus par resolveCompanyAccess ; la garde comptable
// n'accepte que ADMIN de la société active. Composition des deux fonctions pures (aucune DB).
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { resolveCompanyAccess } from "@/lib/company-access"
import { resolveAccountingAccess, type AccountingAccessDeps } from "@/lib/accounting/access/accounting-access.core"

const A = "company-a"
const B = "company-b"
type Profile = { companyId: string; active: boolean; role: string; company: { active: boolean } }
const prof = (companyId: string, role: string, active = true, companyActive = true): Profile => ({
  companyId, role, active, company: { active: companyActive },
})

function account(role: string, companyId: string | null, profiles: Profile[], companyActive = true) {
  return { role, companyId, employeeProfiles: profiles, company: companyId ? { active: companyActive } : null }
}

async function accountingFor(acc: ReturnType<typeof account>, requested: string | null) {
  const access = resolveCompanyAccess(acc, requested)
  const companies: Record<string, { id: string; active: boolean }> = {
    [A]: { id: A, active: true }, [B]: { id: B, active: true },
  }
  const deps: AccountingAccessDeps = {
    isModuleEnabled: () => true,
    auth: async () => (access ? { user: { id: "u1", role: access.role, companyId: access.companyId } } : { user: { id: "u1", role: null, companyId: null } }),
    findCompany: async (id) => companies[id] ?? null,
  }
  return { access, result: await resolveAccountingAccess(deps) }
}

describe("Comptabilité × multi-société", () => {
  it("ADMIN en A et EMPLOYEE en B : refusé lorsque B est la société active", async () => {
    const { access, result } = await accountingFor(account("EMPLOYEE", A, [prof(A, "ADMIN"), prof(B, "EMPLOYEE")]), B)
    assert.deepEqual(access, { companyId: B, role: "EMPLOYEE" })
    assert.deepEqual(result, { ok: false, reason: "FORBIDDEN" })
  })

  it("EMPLOYEE en A et ADMIN en B : accepté en B, contexte comptable = B", async () => {
    const { result } = await accountingFor(account("EMPLOYEE", A, [prof(A, "EMPLOYEE"), prof(B, "ADMIN")]), B)
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.context.companyId, B)
  })

  it("ADMIN en A : contexte comptable = A (jamais une autre société)", async () => {
    const { result } = await accountingFor(account("ADMIN", A, [prof(A, "ADMIN")]), A)
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.context.companyId, A)
  })

  it("profil ADMIN inactif en B : B n'est pas sélectionnable, aucune comptabilité de B", async () => {
    const { access, result } = await accountingFor(account("EMPLOYEE", A, [prof(A, "EMPLOYEE"), prof(B, "ADMIN", false)]), B)
    assert.equal(access?.companyId, A)
    assert.deepEqual(result, { ok: false, reason: "FORBIDDEN" })
  })

  it("société B inactive : profil ignoré", async () => {
    const { access, result } = await accountingFor(account("EMPLOYEE", A, [prof(A, "EMPLOYEE"), prof(B, "ADMIN", true, false)]), B)
    assert.equal(access?.companyId, A)
    assert.equal(result.ok, false)
  })

  it("sélection d'une société étrangère : repli sur la société principale, jamais la société demandée", async () => {
    const { access, result } = await accountingFor(account("ADMIN", A, [prof(A, "ADMIN")]), "company-foreign")
    assert.equal(access?.companyId, A)
    assert.equal(result.ok, true)
    if (result.ok) assert.notEqual(result.context.companyId, "company-foreign")
  })

  it("compte historique ADMIN sans profil employé : accepté sur sa société", async () => {
    const { result } = await accountingFor(account("ADMIN", A, []), null)
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.context.companyId, A)
  })

  it("compte historique dont la société est inactive : aucun contexte, refusé", async () => {
    const { access, result } = await accountingFor(account("ADMIN", A, [], false), null)
    assert.equal(access, null)
    assert.equal(result.ok, false)
  })

  it("SUPER_ADMIN : refusé même avec une société (Lot 0, décision D2)", async () => {
    const { access, result } = await accountingFor(account("SUPER_ADMIN", A, []), A)
    assert.equal(access?.role, "SUPER_ADMIN")
    assert.deepEqual(result, { ok: false, reason: "FORBIDDEN" })
  })

  it("aucune appartenance : refusé", async () => {
    const { result } = await accountingFor(account("EMPLOYEE", null, []), null)
    assert.equal(result.ok, false)
  })
})
