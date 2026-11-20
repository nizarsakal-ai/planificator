/**
 * Lot I Planificator V2 : pilote interne Marketing et Boutique limité à UNE société (20/11/2026). Données synthétiques
 * uniquement : deux sociétés FICTIVES, aucune base, aucun identifiant réel.
 * - Configuration : MARKETING_SHOP_PILOT_ENABLED (ou l'opt-in historique MARKETING_SHOP_ENABLED) strict ET
 *   MARKETING_SHOP_COMPANY_ID exact ; absent, vide ou malformé ⇒ fermé, même drapeau actif ; aucun trim, liste ni joker.
 * - Garde pilotée : hors société pilote ⇒ MODULE_DISABLED, Super Admin compris ; session nulle ⇒ UNAUTHENTICATED ;
 *   société pilote : ADMIN/SUPER_ADMIN admis, autres rôles refusés.
 * - Câblage : garde et menu lisent la même cible ; pages et actions passent par la garde I.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import {
  MARKETING_SHOP_COMPANY_ID_NAME, MARKETING_SHOP_FLAG_NAME, MARKETING_SHOP_PILOT_FLAG_NAME, isMarketingShopEnabled, isMarketingShopEnabledForCompany,
  isMarketingShopPilotEnabled, readMarketingShopPilotCompanyId,
} from "@/lib/marketing-shop/marketing-shop-feature-flag"
import { resolveMarketingShopAccessCore } from "@/lib/marketing-shop/access"

const PILOTE = "co_pilote_fictif"
const AUTRE = "co_autre_fictif"
const PILOT_ON = { MARKETING_SHOP_PILOT_ENABLED: "true", MARKETING_SHOP_COMPANY_ID: PILOTE }
const DISABLED = { ok: false, reason: "MODULE_DISABLED" }
const ROLES = ["SUPER_ADMIN", "ADMIN", "TEAM_LEADER", "EMPLOYEE", "CLIENT"]
const read = (p: string) => readFileSync(p, "utf8")
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")
const session = (role: string, companyId: string | null | undefined, id: string | null = "u1") => ({ user: { id, role, companyId } })

describe("pilote I : configuration", () => {
  it("noms exacts ; drapeaux distincts et stricts", () => {
    assert.deepEqual([MARKETING_SHOP_FLAG_NAME, MARKETING_SHOP_PILOT_FLAG_NAME, MARKETING_SHOP_COMPANY_ID_NAME], ["MARKETING_SHOP_ENABLED", "MARKETING_SHOP_PILOT_ENABLED", "MARKETING_SHOP_COMPANY_ID"])
    assert.equal(isMarketingShopPilotEnabled({ MARKETING_SHOP_PILOT_ENABLED: "true" }), true)
    for (const v of [undefined, "", "TRUE", "1", " true", "true "]) assert.equal(isMarketingShopPilotEnabled({ MARKETING_SHOP_PILOT_ENABLED: v }), false, String(v))
    assert.equal(isMarketingShopEnabled({ MARKETING_SHOP_PILOT_ENABLED: "true" }), false, "le pilote n'active pas le drapeau historique")
  })
  it("société lue telle quelle ; absente, vide ou malformée ⇒ fermé (aucun trim, liste, joker ni séparateur)", () => {
    assert.equal(readMarketingShopPilotCompanyId(PILOT_ON), PILOTE)
    for (const bad of [undefined, "", " ", ` ${PILOTE}`, `${PILOTE} `, `${PILOTE}\n`, `${PILOTE},${AUTRE}`, `${PILOTE};${AUTRE}`, `${PILOTE} ${AUTRE}`, "*", "co_*", "co/pilote", "co.pilote", "a".repeat(65)]) assert.equal(readMarketingShopPilotCompanyId({ ...PILOT_ON, MARKETING_SHOP_COMPANY_ID: bad }), null, JSON.stringify(bad))
  })
  it("jamais d'accès sans société configurée, même avec un drapeau actif ; aucune société sans drapeau", () => {
    for (const env of [{ MARKETING_SHOP_ENABLED: "true" }, { MARKETING_SHOP_PILOT_ENABLED: "true" }, { MARKETING_SHOP_ENABLED: "true", MARKETING_SHOP_PILOT_ENABLED: "true" }]) {
      assert.equal(readMarketingShopPilotCompanyId(env), null, JSON.stringify(env))
      assert.equal(isMarketingShopEnabledForCompany(PILOTE, env), false, JSON.stringify(env))
    }
    assert.equal(readMarketingShopPilotCompanyId({ MARKETING_SHOP_COMPANY_ID: PILOTE }), null, "société seule : fermé")
    assert.equal(isMarketingShopEnabledForCompany(PILOTE, { MARKETING_SHOP_ENABLED: "true", MARKETING_SHOP_COMPANY_ID: PILOTE }), true, "opt-in historique avec société configurée")
  })
  it("ciblage strict : seule la société exactement égale est ouverte", () => {
    assert.equal(isMarketingShopEnabledForCompany(PILOTE, PILOT_ON), true)
    for (const company of [AUTRE, undefined, null, "", ` ${PILOTE}`, `${PILOTE} `, PILOTE.toUpperCase(), 42, {}]) assert.equal(isMarketingShopEnabledForCompany(company, PILOT_ON), false, JSON.stringify(company))
    assert.equal(isMarketingShopEnabledForCompany("*", { ...PILOT_ON, MARKETING_SHOP_COMPANY_ID: "*" }), false, "aucun joker")
  })
})

describe("pilote I : garde pilotée", () => {
  it("sans société pilote configurée ⇒ module inexistant, même sans session", () => {
    for (const pilot of [null, ""]) {
      assert.deepEqual(resolveMarketingShopAccessCore(pilot, session("SUPER_ADMIN", PILOTE)), DISABLED, String(pilot))
      assert.deepEqual(resolveMarketingShopAccessCore(pilot, null), DISABLED, String(pilot))
    }
  })
  it("session nulle ou sans utilisateur ⇒ UNAUTHENTICATED (redirection /login conservée)", () => {
    for (const s of [null, { user: null }, session("ADMIN", PILOTE, null), session("ADMIN", PILOTE, "  ")]) {
      assert.deepEqual(resolveMarketingShopAccessCore(PILOTE, s), { ok: false, reason: "UNAUTHENTICATED" })
    }
  })
  it("hors société pilote ⇒ MODULE_DISABLED pour tous les rôles, Super Admin compris", () => {
    for (const role of ROLES) for (const company of [AUTRE, null, undefined, "", ` ${PILOTE}`, `${PILOTE} `]) {
      assert.deepEqual(resolveMarketingShopAccessCore(PILOTE, session(role, company)), DISABLED, `${role} ${JSON.stringify(company)}`)
    }
  })
  it("société pilote : ADMIN et SUPER_ADMIN admis ; employé, chef d'équipe et client refusés", () => {
    for (const role of ["ADMIN", "SUPER_ADMIN"] as const) {
      assert.deepEqual(resolveMarketingShopAccessCore(PILOTE, session(role, PILOTE)), { ok: true, context: { userId: "u1", companyId: PILOTE, role } })
    }
    for (const role of ["EMPLOYEE", "TEAM_LEADER", "CLIENT"]) {
      assert.deepEqual(resolveMarketingShopAccessCore(PILOTE, session(role, PILOTE)), { ok: false, reason: "FORBIDDEN" }, role)
    }
  })
})

describe("pilote I : câblage", () => {
  it("garde I : cible lue une fois, garde pilotée ; pages et actions par la garde I", () => {
    const access = code(read("src/lib/marketing-shop/access.ts"))
    assert.match(access, /export async function resolveMarketingShopAccess\(\): Promise<StockAccessResult> \{\n\s+const pilotCompanyId = readMarketingShopPilotCompanyId\(\)\n\s+if \(pilotCompanyId === null\) return \{ ok: false, reason: "MODULE_DISABLED" \}\n/)
    assert.ok(access.includes("return resolveMarketingShopAccessCore(pilotCompanyId, session)"))
    assert.equal(access.split("const r = await resolveMarketingShopAccess()").length - 1, 2, "actions et pages")
    assert.doesNotMatch(access, /process\.env|isMarketingShopEnabled\(\)|MARKETING_SHOP_COMPANY_ID/)
    for (const f of ["src/app/(dashboard)/marketing/page.tsx", "src/app/(dashboard)/boutique/page.tsx", "src/app/(dashboard)/boutique/commandes/[orderId]/page.tsx"]) assert.match(read(f), /await marketingShopPageAccess\(\)/, f)
    assert.match(read("src/lib/actions/marketing-shop.actions.ts"), /requireMarketingShopAdmin\(\)/)
  })
  it("menu : même cible que la garde ; aucune lecture côté client", () => {
    const layout = read("src/app/(dashboard)/layout.tsx")
    assert.ok(layout.includes(`const marketingShopNavVisible = isMarketingShopEnabledForCompany(companyId) && (role === "ADMIN" || role === "SUPER_ADMIN")`))
    assert.doesNotMatch(code(layout), /isMarketingShopEnabled\(|MARKETING_SHOP_COMPANY_ID|readMarketingShopPilotCompanyId/)
    for (const f of ["src/components/layout/Sidebar.tsx", "src/components/layout/MobileNav.tsx"]) assert.doesNotMatch(code(read(f)), /MARKETING_SHOP_|marketing-shop-feature-flag/, f)
  })
})
