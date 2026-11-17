/**
 * Lot E Planificator V2 : matrice des QUATRE combinaisons de drapeaux (CRM_OPPORTUNITIES_ENABLED × AUTOMATIONS_ENABLED),
 * logique pure et câblage statique. Aucune base, aucun réseau. Complété par la matrice de navigation
 * (tests/navigation/nav-lot-e.test.ts) et par le cas « pipeline désactivé » sur PostgreSQL jetable (automation.pg.test.ts).
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { ACTIVATION_SCOPE, AUTOMATION_ERRORS, CRM_TRIGGERS, TRIGGERS, availableTriggers, isTriggerAvailable, sameActivation } from "@/lib/automation/automation.core"
import { isAutomationsEnabled } from "@/lib/automation/automation-feature-flag"
import { isCrmEnabled } from "@/lib/crm/crm-feature-flag"
import { resolveAutomationAccessCore } from "@/lib/automation/access"
import { resolveCrmAccessCore } from "@/lib/crm/access"

const read = (f: string) => readFileSync(f, "utf8")
const ADMIN = { user: { id: "u1", role: "ADMIN", companyId: "co1" } } as const
const COMBOS = [
  { crm: false, auto: false }, { crm: true, auto: false }, { crm: false, auto: true }, { crm: true, auto: true },
] as const

describe("quatre combinaisons de drapeaux", () => {
  for (const c of COMBOS) {
    it(`CRM ${c.crm ? "actif" : "désactivé"} × automatisations ${c.auto ? "actives" : "désactivées"}`, () => {
      const env = { CRM_OPPORTUNITIES_ENABLED: c.crm ? "true" : undefined, AUTOMATIONS_ENABLED: c.auto ? "true" : undefined }
      assert.equal(isCrmEnabled(env), c.crm)
      assert.equal(isAutomationsEnabled(env), c.auto)
      // Accès serveur : un module désactivé n'existe pas (MODULE_DISABLED ⇒ 404), même pour un administrateur.
      const crmAccess = resolveCrmAccessCore(c.crm, ADMIN)
      const autoAccess = resolveAutomationAccessCore(c.auto, ADMIN)
      assert.equal(crmAccess.ok, c.crm)
      assert.equal(autoAccess.ok, c.auto)
      if (!c.crm) assert.deepEqual(crmAccess, { ok: false, reason: "MODULE_DISABLED" })
      if (!c.auto) assert.deepEqual(autoAccess, { ok: false, reason: "MODULE_DISABLED" })
      // Déclencheurs disponibles : sans pipeline, seul « devis accepté » ; jamais de déclencheur hors liste fermée.
      assert.deepEqual(availableTriggers(c.crm), c.crm ? [...TRIGGERS] : ["QUOTE_ACCEPTED"])
      for (const t of CRM_TRIGGERS) assert.equal(isTriggerAvailable(t, c.crm), c.crm, t)
      assert.equal(isTriggerAvailable("QUOTE_ACCEPTED", c.crm), true)
      assert.equal(isTriggerAvailable("RESERVE_OVERDUE", c.crm), false)
    })
  }
  it("défaut : les deux modules désactivés (aucune variable)", () => {
    assert.equal(isCrmEnabled({}), false)
    assert.equal(isAutomationsEnabled({}), false)
  })
  it("service : création, approbation et exécution filtrent les déclencheurs d'opportunité selon le pipeline", () => {
    const svc = read("src/lib/automation/automation.service.ts")
    assert.ok(svc.includes("input: RuleInput, crmEnabled: boolean = isCrmEnabled())"))
    assert.match(svc, /if \(!isTriggerAvailable\(v\.value\.trigger, crmEnabled\)\) return \{ ok: false, error: AUTOMATION_ERRORS\.triggerUnavailable \}/)
    assert.ok(svc.includes("export async function approveAndActivate(db: Db, ctx: AutomationContext, id: string, at?: Date, crmEnabled: boolean = isCrmEnabled())"))
    assert.match(svc, /if \(!isTriggerAvailable\(r\.trigger, crmEnabled\)\) fail\(AUTOMATION_ERRORS\.triggerUnavailable\)/)
    assert.ok(svc.includes("const triggers = availableTriggers(crmEnabled)"))
    assert.ok(svc.includes(`where: { status: "ACTIVE", trigger: { in: triggers }`), "filtre de disponibilité appliqué dans la requête, avant la limite")
    assert.ok(AUTOMATION_ERRORS.triggerUnavailable.length > 0)
    const page = read("src/app/(dashboard)/automatisations/page.tsx")
    assert.match(page, /const triggers = availableTriggers\(crmEnabled\)/)
    assert.doesNotMatch(page, /\bTRIGGERS\.map/, "la page ne propose que les déclencheurs disponibles")
  })
  it("tâche planifiée : 404 tant que les automatisations sont désactivées, quel que soit le pipeline", () => {
    const cron = read("src/app/api/cron/automations/route.ts")
    const auth = cron.indexOf("assertCronBearerAuth(req)"), flag = cron.indexOf("if (!isAutomationsEnabled())"), run = cron.indexOf("runAutomations(prisma)")
    assert.ok(auth > 0 && flag > auth && run > flag, "jeton, puis drapeau, puis exécution")
  })
})

describe("désactivation concurrente : même activation exigée sous verrou", () => {
  const t1 = new Date("2026-11-15T10:00:00Z"), t2 = new Date("2026-11-15T10:05:00Z")
  it("règle relue ACTIVE avec la même activation ⇒ exécution", () => {
    assert.equal(sameActivation({ status: "ACTIVE", activatedAt: new Date(t1) }, { activatedAt: t1 }), true)
  })
  it("désactivée, ou réapprouvée entre sélection et exécution ⇒ abandon", () => {
    assert.equal(sameActivation({ status: "DISABLED", activatedAt: t1 }, { activatedAt: t1 }), false)
    assert.equal(sameActivation({ status: "ACTIVE", activatedAt: t2 }, { activatedAt: t1 }), false)
    assert.equal(sameActivation(undefined, { activatedAt: t1 }), false)
    assert.equal(sameActivation({ status: "ACTIVE", activatedAt: null }, { activatedAt: t1 }), false)
    assert.equal(sameActivation({ status: "ACTIVE", activatedAt: t1 }, { activatedAt: null }), false)
  })
  it("l'exécuteur relit statut ET activation sous verrou partagé", () => {
    const svc = read("src/lib/automation/automation.service.ts")
    assert.match(svc, /SELECT "status"::text AS "status", "activatedAt" FROM "automation_rules" WHERE "id" = \$\{rule\.id\} AND "companyId" = \$\{rule\.companyId\} FOR SHARE/)
    assert.match(svc, /if \(locked\.length !== 1 \|\| !sameActivation\(locked\[0\], rule\)\) return "inactive" as const/)
  })
})

describe("portée à l'activation explicitée (revue coordinateur v3 : relance due et arriéré)", () => {
  it("une portée par déclencheur ; relance due : arriéré inclus, une fois par opportunité et date ; déclencheurs datés bornés", () => {
    assert.deepEqual(Object.keys(ACTIVATION_SCOPE).sort(), [...TRIGGERS].sort())
    assert.match(ACTIVATION_SCOPE.OPPORTUNITY_FOLLOW_UP_DUE, /déjà échues à l'activation/)
    assert.match(ACTIVATION_SCOPE.OPPORTUNITY_FOLLOW_UP_DUE, /une seule fois par opportunité et par date de relance/)
    assert.match(ACTIVATION_SCOPE.OPPORTUNITY_STAGE_CHANGED, /postérieurs à l'activation/)
    assert.match(ACTIVATION_SCOPE.QUOTE_ACCEPTED, /après l'activation/)
  })
  it("message d'approbation sans promesse générale « à venir seulement » ; portée affichée sur la page ; critère inchangé", () => {
    const actions = read("src/lib/actions/automation.actions.ts")
    assert.ok(!actions.includes("à venir seulement"), "formulation générale retirée")
    assert.ok(actions.includes("Sa portée à l'activation est indiquée sur sa ligne."))
    assert.ok(read("src/app/(dashboard)/automatisations/page.tsx").includes("{ACTIVATION_SCOPE[r.trigger]}"))
    const svc = read("src/lib/automation/automation.service.ts")
    const fu = svc.slice(svc.indexOf('if (t === "OPPORTUNITY_FOLLOW_UP_DUE")'), svc.indexOf('if (t === "QUOTE_ACCEPTED")'))
    assert.ok(fu.includes("nextFollowUpDate: { lte: today }") && !fu.includes("since"), "relance due : aucune borne d'activation (comportement documenté)")
    for (const t of ['if (t === "OPPORTUNITY_STAGE_CHANGED")', 'if (t === "QUOTE_ACCEPTED")']) {
      const part = svc.slice(svc.indexOf(t), svc.indexOf(t) + 400)
      assert.ok(part.includes("{ gte: since }"), `${t} : borne activatedAt`)
    }
  })
})
