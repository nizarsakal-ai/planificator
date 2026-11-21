/**
 * Lot F Planificator V2 : pilote Assistant et Connecteurs limité à UNE société (20/11/2026). Données synthétiques :
 * sociétés FICTIVES, aucun identifiant réel, aucune base, aucun réseau.
 * - Deux drapeaux pilotes stricts et indépendants ; cible serveur commune LOT_F_PILOT_COMPANY_ID exacte.
 * - Aucun accès sans cible valide, même drapeau pilote ou historique actif.
 * - Gardes : hors cible MODULE_DISABLED (Super Admin compris), employé refusé, session absente UNAUTHENTICATED.
 * - Câblage : garde et menu lisent la même cible par module ; pages et actions gardent leurs gardes.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { LOT_F_PILOT_COMPANY_ID_NAME, matchesLotFPilot, readLotFPilotCompanyId } from "@/lib/lot-f/pilot-target"
import { ASSISTANT_PILOT_FLAG_NAME, isAssistantEnabled, isAssistantEnabledForCompany, isAssistantPilotEnabled, readAssistantPilotCompanyId } from "@/lib/assistant/assistant-feature-flag"
import { CONNECTOR_CENTER_PILOT_FLAG_NAME, isConnectorCenterEnabled, isConnectorCenterEnabledForCompany, isConnectorCenterPilotEnabled, readConnectorCenterPilotCompanyId } from "@/lib/connectors/connector-feature-flag"
import { resolveAssistantAccessCore } from "@/lib/assistant/access"
import { resolveConnectorAccessCore } from "@/lib/connectors/access"

const PILOTE = "co_pilote_fictif"
const AUTRE = "co_autre_fictif"
const read = (p: string) => readFileSync(p, "utf8")
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")
const session = (role: string | null, companyId: string | null | undefined, id: string | null = "u1") => ({ user: { id, role, companyId } })
const MODULES = [
  ["assistant", "ASSISTANT_PILOT_ENABLED", "ASSISTANT_ENABLED", readAssistantPilotCompanyId, isAssistantEnabledForCompany],
  ["connecteurs", "CONNECTOR_CENTER_PILOT_ENABLED", "CONNECTOR_CENTER_ENABLED", readConnectorCenterPilotCompanyId, isConnectorCenterEnabledForCompany],
] as const

describe("pilote F : configuration", () => {
  it("noms exacts ; nouveaux drapeaux stricts, sans effet sur les drapeaux historiques bruts", () => {
    assert.equal(LOT_F_PILOT_COMPANY_ID_NAME, "LOT_F_PILOT_COMPANY_ID")
    assert.deepEqual([ASSISTANT_PILOT_FLAG_NAME, CONNECTOR_CENTER_PILOT_FLAG_NAME], ["ASSISTANT_PILOT_ENABLED", "CONNECTOR_CENTER_PILOT_ENABLED"])
    for (const [fn, name] of [[isAssistantPilotEnabled, "ASSISTANT_PILOT_ENABLED"], [isConnectorCenterPilotEnabled, "CONNECTOR_CENTER_PILOT_ENABLED"]] as const) {
      assert.equal(fn({ [name]: "true" }), true, name)
      for (const v of [undefined, "", "TRUE", "1", " true", "true "]) assert.equal(fn({ [name]: v }), false, `${name}=${String(v)}`)
    }
    const both = { ASSISTANT_PILOT_ENABLED: "true", CONNECTOR_CENTER_PILOT_ENABLED: "true", LOT_F_PILOT_COMPANY_ID: PILOTE }
    assert.equal(isAssistantEnabled(both), false)
    assert.equal(isConnectorCenterEnabled(both), false)
  })
  it("drapeaux pilotes indépendants : chacun n'ouvre que son module", () => {
    const assistantSeul = { ASSISTANT_PILOT_ENABLED: "true", LOT_F_PILOT_COMPANY_ID: PILOTE }
    assert.deepEqual([isAssistantEnabledForCompany(PILOTE, assistantSeul), isConnectorCenterEnabledForCompany(PILOTE, assistantSeul)], [true, false])
    const connecteursSeuls = { CONNECTOR_CENTER_PILOT_ENABLED: "true", LOT_F_PILOT_COMPANY_ID: PILOTE }
    assert.deepEqual([isAssistantEnabledForCompany(PILOTE, connecteursSeuls), isConnectorCenterEnabledForCompany(PILOTE, connecteursSeuls)], [false, true])
  })
  for (const [name, pilotFlag, legacyFlag, readTarget, forCompany] of MODULES) {
    it(`${name} : cible absente ou malformée ⇒ fermé, drapeau pilote ou historique actif ; ciblage exact`, () => {
      for (const flag of [pilotFlag, legacyFlag]) {
        assert.equal(readTarget({ [flag]: "true" }), null, `${flag} sans cible`)
        for (const bad of ["", " ", ` ${PILOTE}`, `${PILOTE} `, `${PILOTE}\n`, `${PILOTE},${AUTRE}`, "*", "co/pilote", "co.pilote", "a".repeat(65)]) {
          assert.equal(readTarget({ [flag]: "true", LOT_F_PILOT_COMPANY_ID: bad }), null, `${flag} ${JSON.stringify(bad)}`)
        }
        assert.equal(readTarget({ [flag]: "true", LOT_F_PILOT_COMPANY_ID: PILOTE }), PILOTE, flag)
      }
      assert.equal(readTarget({ LOT_F_PILOT_COMPANY_ID: PILOTE }), null, "cible seule : fermé")
      const env = { [pilotFlag]: "true", LOT_F_PILOT_COMPANY_ID: PILOTE }
      assert.equal(forCompany(PILOTE, env), true)
      for (const c of [AUTRE, undefined, null, "", ` ${PILOTE}`, PILOTE.toUpperCase(), 42]) assert.equal(forCompany(c, env), false, JSON.stringify(c))
    })
  }
  it("parseur commun pur : ne lit aucun drapeau, compare sans normaliser", () => {
    assert.equal(readLotFPilotCompanyId(false, { LOT_F_PILOT_COMPANY_ID: PILOTE }), null)
    assert.equal(readLotFPilotCompanyId(true, { LOT_F_PILOT_COMPANY_ID: PILOTE }), PILOTE)
    assert.deepEqual([matchesLotFPilot(PILOTE, null), matchesLotFPilot(PILOTE, PILOTE), matchesLotFPilot(` ${PILOTE}`, PILOTE)], [false, true, false])
  })
})

describe("pilote F : gardes à portée de société", () => {
  for (const [name, resolve] of [["assistant", resolveAssistantAccessCore], ["connecteurs", resolveConnectorAccessCore]] as const) {
    it(`${name} : hors cible MODULE_DISABLED (Super Admin compris) ; employé refusé ; session absente UNAUTHENTICATED ; sans cible fermé`, () => {
      for (const role of ["SUPER_ADMIN", "ADMIN", "TEAM_LEADER", "EMPLOYEE", "CLIENT"]) for (const c of [AUTRE, null, undefined, "", ` ${PILOTE}`]) {
        assert.deepEqual(resolve(PILOTE, session(role, c)), { ok: false, reason: "MODULE_DISABLED" }, `${role} ${JSON.stringify(c)}`)
      }
      for (const role of ["EMPLOYEE", "TEAM_LEADER"]) assert.deepEqual(resolve(PILOTE, session(role, PILOTE)), { ok: false, reason: "FORBIDDEN" }, role)
      for (const role of ["ADMIN", "SUPER_ADMIN"] as const) assert.deepEqual(resolve(PILOTE, session(role, PILOTE)), { ok: true, context: { userId: "u1", companyId: PILOTE, role } })
      for (const s of [null, { user: null }, session("ADMIN", PILOTE, null)]) assert.deepEqual(resolve(PILOTE, s), { ok: false, reason: "UNAUTHENTICATED" })
      for (const pilot of [null, ""]) assert.deepEqual(resolve(pilot, session("SUPER_ADMIN", PILOTE)), { ok: false, reason: "MODULE_DISABLED" }, String(pilot))
    })
  }
})

describe("pilote F : câblage", () => {
  for (const [file, reader, core] of [["src/lib/assistant/access.ts", "readAssistantPilotCompanyId", "resolveAssistantAccessCore"], ["src/lib/connectors/access.ts", "readConnectorCenterPilotCompanyId", "resolveConnectorAccessCore"]] as const) {
    it(`${file} : cible lue par la fonction du module ; aucune garde sans cible`, () => {
      const c = code(read(file))
      assert.match(c, new RegExp(`const pilotCompanyId = ${reader}\\(\\)\\n\\s+if \\(pilotCompanyId === null\\) return \\{ ok: false, reason: "MODULE_DISABLED" \\}`))
      assert.ok(c.includes(`return ${core}(pilotCompanyId, session)`))
      assert.ok(c.includes(`export function ${core}(pilotCompanyId: string | null, session: StockSessionLike | null)`))
      assert.doesNotMatch(c, /resolveStockAccessCore\(enabled|isAssistantEnabled\(\)|isConnectorCenterEnabled\(\)|process\.env/)
    })
  }
  it("layout : même lecture de cible que la garde ; aucune lecture côté client", () => {
    const layout = read("src/app/(dashboard)/layout.tsx")
    assert.ok(layout.includes(`const assistantNavVisible = isAssistantEnabledForCompany(companyId) && (role === "ADMIN" || role === "SUPER_ADMIN")`))
    assert.ok(layout.includes(`const connectorsNavVisible = isConnectorCenterEnabledForCompany(companyId) && (role === "ADMIN" || role === "SUPER_ADMIN")`))
    assert.doesNotMatch(code(layout), /isAssistantEnabled\(|isConnectorCenterEnabled\(|LOT_F_PILOT_COMPANY_ID/)
    for (const f of ["src/components/layout/Sidebar.tsx", "src/components/layout/MobileNav.tsx"]) assert.doesNotMatch(code(read(f)), /LOT_F_PILOT|_PILOT_ENABLED|pilot-target/, f)
  })
  it("/assistant, /connecteurs et leurs actions : gardes existantes", () => {
    assert.match(read("src/app/(dashboard)/assistant/page.tsx"), /await assistantPageAccess\(\)/)
    assert.match(read("src/app/(dashboard)/connecteurs/page.tsx"), /await connectorPageAccess\(\)/)
    assert.match(read("src/lib/actions/assistant.actions.ts"), /requireAssistantAdmin\(\)/)
    assert.match(read("src/lib/actions/connector.actions.ts"), /requireConnectorAdmin\(\)/)
  })
})
