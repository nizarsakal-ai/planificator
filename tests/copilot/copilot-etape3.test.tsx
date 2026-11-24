/**
 * Étape 3 adaptée (24/11/2026) : retrait de l'entrée de menu « Propositions » derrière ASSISTANT_MENU_CONSOLIDATED
 * (désactivé par défaut), décidé avec les gardes de l'étape 2. Reprise de la proposition 4be15d3 (drapeau, câblage du
 * menu) et du libellé c655ebf. Matrice exhaustive : rôles × lot F × copilote × drapeau.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { isAssistantEnabledForCompany } from "@/lib/assistant/assistant-feature-flag"
import { assistantDenialStatus } from "@/lib/assistant/access"
import { copilotAdminGuardCore, resolveAssistantAccessCore } from "@/lib/copilot/copilot-guards"
import { copilotConfig } from "@/lib/copilot/copilot-config"
import { isCopilotRoleAllowed } from "@/lib/copilot/copilot-roles"
import { resolveCopilotTabs, type SourceGuard } from "@/lib/copilot/copilot-tabs"
import { isAssistantMenuConsolidationEnabled, isAssistantMenuReplaced } from "@/lib/navigation/assistant-entry"
import { EXTERNAL_LLM_NOTE, PROVIDERS } from "@/lib/assistant/providers"

const A = "co_a", B = "co_b"
const ROLES = ["SUPER_ADMIN", "ADMIN", "TEAM_LEADER", "EMPLOYEE", "CLIENT"] as const
const LOT_F = { off: {}, a: { ASSISTANT_PILOT_ENABLED: "true", LOT_F_PILOT_COMPANY_ID: A }, b: { ASSISTANT_PILOT_ENABLED: "true", LOT_F_PILOT_COMPANY_ID: B } }
const COPILOT = {
  off: {}, a: { COPILOT_ENABLED: "true", COPILOT_COMPANY_ID: A, ANTHROPIC_API_KEY: "k" },
  aAll: { COPILOT_ENABLED: "true", COPILOT_COMPANY_ID: A, ANTHROPIC_API_KEY: "k", COPILOT_ROLES: "ADMIN,SUPER_ADMIN,TEAM_LEADER,EMPLOYEE,CLIENT" },
  sansCle: { COPILOT_ENABLED: "true", COPILOT_COMPANY_ID: A }, b: { COPILOT_ENABLED: "true", COPILOT_COMPANY_ID: B, ANTHROPIC_API_KEY: "k" },
}
const FLAG = { absent: {}, true: { ASSISTANT_MENU_CONSOLIDATED: "true" }, autre: { ASSISTANT_MENU_CONSOLIDATED: "1" } }

/** Reproduit le calcul de la coquille (layout) pour un utilisateur et un environnement donnés. */
function shell(role: string, env: Record<string, string>) {
  const admin = role === "ADMIN" || role === "SUPER_ADMIN"
  const assistantNavVisible = isAssistantEnabledForCompany(A, env) && admin // formule figée du lot F
  const copilotVisible = isCopilotRoleAllowed(role, env) && copilotConfig(A, env) !== null
  const r = resolveAssistantAccessCore(isAssistantEnabledForCompany(A, env) ? A : (env.LOT_F_PILOT_COMPANY_ID && env.ASSISTANT_PILOT_ENABLED === "true" ? env.LOT_F_PILOT_COMPANY_ID : null), { user: { id: "u1", role, companyId: A } })
  const rules: SourceGuard = r.ok ? { ok: true, companyId: r.context.companyId } : { ok: false, status: assistantDenialStatus(r.reason) }
  const tabs = resolveCopilotTabs({ copilotVisible, rules, copilotAdmin: copilotAdminGuardCore({ id: "u1", role, companyId: A }, env) })
  const replaced = copilotVisible ? isAssistantMenuReplaced(tabs, env) : isAssistantMenuReplaced([], env)
  const menuEntry = assistantNavVisible && !replaced // câblage Sidebar / MobileNav
  return { assistantNavVisible, menuEntry, tab: tabs.includes("propositions"), rulesOk: r.ok }
}

describe("étape 3 adaptée : matrice rôles × lot F × copilote × drapeau", () => {
  let cases = 0
  for (const role of ROLES) for (const [lk, lot] of Object.entries(LOT_F)) for (const [ck, cop] of Object.entries(COPILOT)) for (const [fk, flag] of Object.entries(FLAG)) {
    const env = { ...lot, ...cop, ...flag } as Record<string, string>
    const s = shell(role, env)
    cases++
    const label = `${role} lot=${lk} copilote=${ck} drapeau=${fk}`
    // Équivalence de règle : la visibilité de menu existante et la garde de la route /assistant coïncident.
    assert.equal(s.assistantNavVisible, s.rulesOk, `${label} : menu ⇔ garde /assistant`)
    // Jamais d'accès sans droit.
    if (!s.rulesOk) assert.ok(!s.menuEntry && !s.tab, `${label} : aucun accès`)
    // Drapeau absent ou ≠ "true" : composition identique à l'existant.
    if (fk !== "true") assert.equal(s.menuEntry, s.assistantNavVisible, `${label} : menu inchangé`)
    // Drapeau "true" : un administrateur autorisé garde EXACTEMENT un accès (menu ou onglet), jamais zéro ni deux.
    if (fk === "true" && s.rulesOk) assert.equal(Number(s.menuEntry) + Number(s.tab), 1, `${label} : un seul accès`)
  }
  it(`${Object.keys(LOT_F).length * Object.keys(COPILOT).length * Object.keys(FLAG).length * ROLES.length} combinaisons vérifiées`, () => assert.equal(cases, 225))
  it("drapeau strict, désactivé par défaut", () => {
    assert.equal(isAssistantMenuConsolidationEnabled({}), false)
    assert.equal(isAssistantMenuConsolidationEnabled({ ASSISTANT_MENU_CONSOLIDATED: "1" }), false)
    assert.equal(isAssistantMenuReplaced(["discussion", "propositions", "journal"], {}), false)
    assert.equal(isAssistantMenuReplaced(["discussion", "journal"], { ASSISTANT_MENU_CONSOLIDATED: "true" }), false, "sans onglet Propositions, l'entrée reste")
    assert.equal(isAssistantMenuReplaced(["discussion", "propositions", "journal"], { ASSISTANT_MENU_CONSOLIDATED: "true" }), true)
  })
})

describe("câblage et libellé", () => {
  it("le layout dérive le retrait des onglets serveur ; menus bureau et mobile identiques", () => {
    const layout = readFileSync("src/app/(dashboard)/layout.tsx", "utf8")
    assert.ok(layout.includes("const assistantMenuReplaced = isAssistantMenuReplaced(copilotTabs)"))
    assert.ok(layout.includes(`const assistantNavVisible = isAssistantEnabledForCompany(companyId) && (role === "ADMIN" || role === "SUPER_ADMIN")`), "formule figée du lot F intacte")
    for (const f of ["src/components/layout/Sidebar.tsx", "src/components/layout/MobileNav.tsx"]) {
      assert.ok(readFileSync(f, "utf8").includes("user.assistantNavVisible === true && user.assistantMenuReplaced !== true"), f)
    }
  })
  it("libellé exact du fournisseur externe (reformulation c655ebf)", () => {
    const ext = PROVIDERS.find((p) => p.id === "EXTERNAL_LLM")!
    assert.equal(ext.note, EXTERNAL_LLM_NOTE)
    assert.match(ext.note, /Non utilisé pour ces propositions/)
    assert.match(ext.note, /Assistant IA/)
    assert.doesNotMatch(ext.note, /aucune donnée transmise/)
  })
})
