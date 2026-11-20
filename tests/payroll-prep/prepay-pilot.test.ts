/**
 * Lot H Planificator V2 : pilote Pré-paie limité à UNE société (20/11/2026). Données synthétiques uniquement : deux
 * sociétés FICTIVES, aucune base, aucun identifiant réel.
 * - Prédicat de configuration : drapeau strict ET PAYROLL_PREP_COMPANY_ID exact ; absent, vide ou malformé ⇒ fermé ;
 *   aucun trim, aucune liste, aucun joker.
 * - Garde H pure : société de session différente ⇒ MODULE_DISABLED (404), Super Admin compris ; session absente et règle
 *   de rôle ADMIN/SUPER_ADMIN conservées pour la société pilote.
 * - Câblage : garde serveur et layout lisent la même configuration ; aucune lecture côté client.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import {
  PAYROLL_PREP_COMPANY_ID_NAME, PAYROLL_PREP_FLAG_NAME, PAYROLL_PREP_PILOT_FLAG_NAME,
  isPayrollPrepEnabled, isPayrollPrepEnabledForCompany, readPayrollPrepPilotCompanyId,
} from "@/lib/payroll-prep/prepay-feature-flag"
import { prepayDenialStatus, resolvePrepayAccessCore } from "@/lib/payroll-prep/access"

const PILOTE = "co_pilote_fictif"
const AUTRE = "co_autre_fictif"
const ON = { PAYROLL_PREP_ENABLED: "true", PAYROLL_PREP_COMPANY_ID: PILOTE }
const DISABLED = { ok: false, reason: "MODULE_DISABLED" }
const ROLES = ["SUPER_ADMIN", "ADMIN", "TEAM_LEADER", "EMPLOYEE", "CLIENT"]
const read = (p: string) => readFileSync(p, "utf8")
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")
const session = (role: string, companyId: string | null | undefined, id: string | null = "u1") => ({ user: { id, role, companyId } })

describe("pilote H : prédicat de configuration", () => {
  it("noms exacts ; drapeau seul inchangé", () => {
    assert.equal(PAYROLL_PREP_FLAG_NAME, "PAYROLL_PREP_ENABLED")
    assert.equal(PAYROLL_PREP_COMPANY_ID_NAME, "PAYROLL_PREP_COMPANY_ID")
    assert.equal(isPayrollPrepEnabled({ PAYROLL_PREP_ENABLED: "true" }), true)
    assert.equal(isPayrollPrepEnabled({}), false)
  })
  it("l'activation du pilote sans drapeau global exige une société exacte", () => {
    const flag = { [PAYROLL_PREP_PILOT_FLAG_NAME]: "true" }
    const configured = { ...flag, [PAYROLL_PREP_COMPANY_ID_NAME]: PILOTE }
    assert.equal(isPayrollPrepEnabledForCompany(PILOTE, configured), true)
    assert.equal(isPayrollPrepEnabledForCompany(AUTRE, configured), false)
    assert.equal(isPayrollPrepEnabledForCompany(PILOTE, flag), false)
    assert.equal(isPayrollPrepEnabledForCompany(PILOTE, { ...configured, [PAYROLL_PREP_PILOT_FLAG_NAME]: "TRUE" }), false)
  })
  it("identifiant lu tel quel ; absent, vide ou malformé ⇒ null (aucun trim, liste, joker ni séparateur)", () => {
    assert.equal(readPayrollPrepPilotCompanyId(ON), PILOTE)
    for (const bad of [undefined, "", " ", ` ${PILOTE}`, `${PILOTE} `, `${PILOTE}\n`, `${PILOTE},${AUTRE}`, `${PILOTE};${AUTRE}`, `${PILOTE} ${AUTRE}`, "*", "co_*", "co/pilote", "co.pilote", "a".repeat(65)]) {
      assert.equal(readPayrollPrepPilotCompanyId({ ...ON, PAYROLL_PREP_COMPANY_ID: bad }), null, JSON.stringify(bad))
    }
  })
  it("ouvert seulement si drapeau strict ET société exactement égale à la société pilote", () => {
    assert.equal(isPayrollPrepEnabledForCompany(PILOTE, ON), true)
    for (const company of [AUTRE, undefined, null, "", ` ${PILOTE}`, `${PILOTE} `, PILOTE.toUpperCase(), 42, {}]) {
      assert.equal(isPayrollPrepEnabledForCompany(company, ON), false, JSON.stringify(company))
    }
    for (const flag of [undefined, "", "TRUE", "1", " true", "true "]) {
      assert.equal(isPayrollPrepEnabledForCompany(PILOTE, { ...ON, PAYROLL_PREP_ENABLED: flag }), false, `drapeau ${JSON.stringify(flag)}`)
    }
    for (const id of [undefined, "", ` ${PILOTE}`, "*"]) {
      assert.equal(isPayrollPrepEnabledForCompany(id === "*" ? "*" : PILOTE, { ...ON, PAYROLL_PREP_COMPANY_ID: id }), false, `config ${JSON.stringify(id)}`)
    }
  })
})

describe("pilote H : garde pure", () => {
  it("module inexistant tant que le drapeau ou la société pilote manque, même sans session", () => {
    for (const config of [{ PAYROLL_PREP_COMPANY_ID: PILOTE }, { PAYROLL_PREP_ENABLED: "true" }]) {
      const pilot = readPayrollPrepPilotCompanyId(config)
      assert.deepEqual(resolvePrepayAccessCore(pilot, session("ADMIN", PILOTE)), DISABLED)
      assert.deepEqual(resolvePrepayAccessCore(pilot, null), DISABLED)
    }
  })
  it("session absente ou sans utilisateur ⇒ UNAUTHENTICATED (connexion), comme avant", () => {
    for (const s of [null, { user: null }, session("ADMIN", PILOTE, null), session("ADMIN", PILOTE, "  ")]) {
      assert.deepEqual(resolvePrepayAccessCore(PILOTE, s), { ok: false, reason: "UNAUTHENTICATED" })
    }
  })
  it("autre société, société absente ou non exacte ⇒ MODULE_DISABLED pour tous les rôles, Super Admin compris", () => {
    for (const role of ROLES) for (const company of [AUTRE, null, undefined, "", ` ${PILOTE}`, `${PILOTE} `]) {
      assert.deepEqual(resolvePrepayAccessCore(PILOTE, session(role, company)), DISABLED, `${role} ${JSON.stringify(company)}`)
    }
  })
  it("société pilote : ADMIN et SUPER_ADMIN admis avec le contexte de session ; autres rôles refusés (FORBIDDEN)", () => {
    for (const role of ["ADMIN", "SUPER_ADMIN"] as const) {
      assert.deepEqual(resolvePrepayAccessCore(PILOTE, session(role, PILOTE)), { ok: true, context: { userId: "u1", companyId: PILOTE, role } })
    }
    for (const role of ["TEAM_LEADER", "EMPLOYEE", "CLIENT"]) {
      assert.deepEqual(resolvePrepayAccessCore(PILOTE, session(role, PILOTE)), { ok: false, reason: "FORBIDDEN" }, role)
    }
  })
  it("réponses HTTP inchangées : module inexistant 404, non connecté 401, refusé 403", () => {
    const denials = ["MODULE_DISABLED", "UNAUTHENTICATED", "FORBIDDEN", "NO_COMPANY"] as const
    assert.deepEqual(denials.map(prepayDenialStatus), [404, 401, 403, 403])
  })
})

describe("pilote H : câblage", () => {
  it("garde serveur : configuration lue une fois, garde pilote appliquée ; pages, actions et export par la même garde", () => {
    const access = code(read("src/lib/payroll-prep/access.ts"))
    assert.match(access, /export async function resolvePrepayAccess\(\): Promise<StockAccessResult> \{\n\s+const pilotCompanyId = readPayrollPrepPilotCompanyId\(\)\n\s+if \(pilotCompanyId === null\) return \{ ok: false, reason: "MODULE_DISABLED" \}\n/)
    assert.ok(access.includes("return resolvePrepayAccessCore(pilotCompanyId, session)"))
    assert.equal(access.split("const r = await resolvePrepayAccess()").length - 1, 2, "requirePrepayAdmin et prepayPageAccess")
    assert.doesNotMatch(access, /process\.env|PAYROLL_PREP_COMPANY_ID/)
    assert.match(read("src/app/(dashboard)/pre-paie/[periodId]/export/route.ts"), /const access = await resolvePrepayAccess\(\)/)
    assert.match(read("src/lib/actions/payroll-prep.actions.ts"), /await requirePrepayAdmin\(\)/)
    for (const f of ["src/app/(dashboard)/pre-paie/page.tsx", "src/app/(dashboard)/pre-paie/[periodId]/page.tsx"]) assert.match(read(f), /await prepayPageAccess\(\)/, f)
  })
  it("configuration : lecture stricte sans trim ; layout par le même prédicat ; aucune lecture côté client", () => {
    const flag = code(read("src/lib/payroll-prep/prepay-feature-flag.ts"))
    assert.doesNotMatch(flag, /\.trim\(|\.split\(|toLowerCase|toUpperCase/)
    const layout = read("src/app/(dashboard)/layout.tsx")
    assert.ok(layout.includes(`const payrollPrepNavVisible = isPayrollPrepEnabledForCompany(companyId) && (role === "ADMIN" || role === "SUPER_ADMIN")`))
    assert.doesNotMatch(code(layout), /PAYROLL_PREP_COMPANY_ID|readPayrollPrepPilotCompanyId|isPayrollPrepEnabled\(/)
    for (const f of ["src/components/layout/Sidebar.tsx", "src/components/layout/MobileNav.tsx"]) assert.doesNotMatch(code(read(f)), /PAYROLL_PREP_COMPANY_ID|prepay-feature-flag/, f)
  })
})
