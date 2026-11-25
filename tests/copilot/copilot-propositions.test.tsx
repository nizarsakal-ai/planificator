/**
 * Navigation assistant, étape 1 (24/11/2026) : l'entrée du lot F devient « Propositions » (route /assistant inchangée).
 * Garde de la route /assistant (drapeau lot F, société active = cible, rôle ADMIN ou SUPER_ADMIN). Le lien du panneau
 * de l'étape 1 est remplacé à l'étape 2 par l'onglet Propositions (tests : copilot-onglets.test.tsx).
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolveAssistantAccessCore } from "@/lib/assistant/access"
import { readAssistantPilotCompanyId } from "@/lib/assistant/assistant-feature-flag"
import { ASSISTANT_NAV_ITEM } from "@/lib/navigation/nav-config"

const PILOT = "co_pilote"
const session = (role: string, companyId: string | null = PILOT) => ({ user: { id: "u1", role, companyId } })
const read = (p: string) => readFileSync(p, "utf8")

describe("contrôle d'accès réutilisé (route /assistant)", () => {
  it("administrateur autorisé : ADMIN et SUPER_ADMIN de la société pilote", () => {
    for (const role of ["ADMIN", "SUPER_ADMIN"]) assert.equal(resolveAssistantAccessCore(PILOT, session(role)).ok, true, role)
  })
  it("rôle non administrateur : refusé, même dans la société pilote", () => {
    for (const role of ["TEAM_LEADER", "EMPLOYEE", "CLIENT"]) assert.equal(resolveAssistantAccessCore(PILOT, session(role)).ok, false, role)
  })
  it("lot inactif : drapeau coupé ou cible absente ⇒ refusé ; autre société ⇒ refusé", () => {
    assert.equal(readAssistantPilotCompanyId({ LOT_F_PILOT_COMPANY_ID: PILOT }), null, "drapeau coupé")
    assert.equal(readAssistantPilotCompanyId({ ASSISTANT_PILOT_ENABLED: "true" }), null, "cible absente")
    assert.equal(readAssistantPilotCompanyId({ ASSISTANT_PILOT_ENABLED: "true", LOT_F_PILOT_COMPANY_ID: PILOT }), PILOT)
    assert.deepEqual(resolveAssistantAccessCore(null, session("ADMIN")), { ok: false, reason: "MODULE_DISABLED" })
    assert.deepEqual(resolveAssistantAccessCore(PILOT, session("ADMIN", "co_autre")), { ok: false, reason: "MODULE_DISABLED" })
  })
})

describe("renommage « Propositions », route inchangée", () => {
  it("entrée de menu et titre de page", () => {
    assert.deepEqual([ASSISTANT_NAV_ITEM.label, ASSISTANT_NAV_ITEM.href], ["Propositions", "/assistant"])
    assert.ok(read("src/app/(dashboard)/assistant/page.tsx").includes('<Sparkles className="h-6 w-6 text-[#0f3460]" /> Propositions</h1>'))
  })
})
