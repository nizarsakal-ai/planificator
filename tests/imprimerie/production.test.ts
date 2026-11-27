import assert from "node:assert/strict"
import { test } from "node:test"
import {
  imprimerieProductionDossier,
  imprimerieProductionMenuVisible,
  imprimerieWorksiteHref,
  PRINT_MANAGER_STUDIO_URL,
} from "../../src/lib/imprimerie/production"
import { groupNavItems } from "../../src/lib/navigation/nav-categories"
import { getNavItems, withImprimerieNavItem } from "../../src/lib/navigation/nav-config"

const env = {
  VERCEL_ENV: "production",
  IMPRIMERIE_PRODUCTION_ENABLED: "true",
  IMPRIMERIE_COMPANY_ID: "entreprise-configuree",
  IMPRIMERIE_WORKSITE_ID: "chantier-associe",
  IMPRIMERIE_QUOTE_NUMBER: "DEV-2026-0110",
}
const owner = { companyId: env.IMPRIMERIE_COMPANY_ID, role: "ADMIN" }

test("l’accès ouvre seulement le dossier configuré à l’administrateur de son entreprise", () => {
  assert.deepEqual(imprimerieProductionDossier(owner, env), {
    companyId: "entreprise-configuree",
    worksiteId: "chantier-associe",
    quoteNumber: "DEV-2026-0110",
  })
  assert.equal(imprimerieProductionDossier({ ...owner, role: "EMPLOYEE" }, env), undefined)
  assert.equal(imprimerieProductionDossier({ companyId: null, role: "SUPER_ADMIN" }, env), undefined)
  assert.equal(imprimerieProductionDossier({ companyId: "autre-entreprise", role: "ADMIN" }, env), undefined)
  assert.equal(PRINT_MANAGER_STUDIO_URL, "https://app.galyaevents.fr/studio")
})

test("le dossier reste fermé en Preview et en l’absence de configuration complète", () => {
  assert.equal(imprimerieProductionDossier(owner, { ...env, VERCEL_ENV: "preview" }), undefined)
  assert.equal(imprimerieProductionDossier(owner, { ...env, IMPRIMERIE_PRODUCTION_ENABLED: undefined }), undefined)
  assert.equal(imprimerieProductionDossier(owner, { ...env, IMPRIMERIE_WORKSITE_ID: undefined }), undefined)
  assert.equal(imprimerieProductionDossier(owner, { ...env, IMPRIMERIE_QUOTE_NUMBER: " " }), undefined)
  assert.equal(imprimerieProductionDossier(owner, { ...env, IMPRIMERIE_QUOTE_NUMBER: "../devis" }), undefined)
})

test("la demande de facture exige un droit explicite pour la société, le chantier et le devis exacts", () => {
  const possible = imprimerieProductionDossier(owner, env)
  const scope = [env.IMPRIMERIE_COMPANY_ID, env.IMPRIMERIE_WORKSITE_ID, env.IMPRIMERIE_QUOTE_NUMBER]
  const invoiceEnv = { ...env, IMPRIMERIE_INVOICE_READ_SCOPE: JSON.stringify(scope) }
  assert.deepEqual(imprimerieProductionDossier(owner, invoiceEnv), {
    ...possible,
    invoiceRequestScope: encodeURIComponent(JSON.stringify(scope)),
  })

  for (const IMPRIMERIE_INVOICE_READ_SCOPE of [
    undefined,
    "true",
    JSON.stringify(scope.slice(0, 2)),
    JSON.stringify(["autre-entreprise", scope[1], scope[2]]),
    JSON.stringify([scope[0], "autre-chantier", scope[2]]),
    JSON.stringify([scope[0], scope[1], "DEV-AUTRE"]),
  ]) {
    assert.deepEqual(imprimerieProductionDossier(owner, { ...env, IMPRIMERIE_INVOICE_READ_SCOPE }), possible)
  }
  assert.equal(imprimerieProductionDossier({ ...owner, role: "EMPLOYEE" }, invoiceEnv), undefined)
  assert.equal(imprimerieProductionDossier(owner, { ...invoiceEnv, VERCEL_ENV: "preview" }), undefined)
})

test("la société peut ouvrir Imprimerie sans autoriser la lecture des devis", () => {
  const menu = { VERCEL_ENV: "production", IMPRIMERIE_MENU_COMPANY_ID: owner.companyId }
  assert.equal(imprimerieProductionMenuVisible(owner, menu), true)
  assert.equal(imprimerieProductionMenuVisible({ ...owner, role: "SUPER_ADMIN" }, menu), true)
  assert.equal(imprimerieProductionMenuVisible({ ...owner, role: "EMPLOYEE" }, menu), false)
  assert.equal(imprimerieProductionMenuVisible({ ...owner, companyId: "autre-entreprise" }, menu), false)
  assert.equal(imprimerieProductionMenuVisible(owner, { ...menu, VERCEL_ENV: "preview" }), false)
  assert.equal(imprimerieProductionMenuVisible(owner, {}), false)
  assert.equal(imprimerieProductionMenuVisible(owner, env), true)
  assert.equal(imprimerieProductionDossier(owner, menu), undefined)
})

test("Imprimerie se place après Chantiers uniquement lorsque le dossier est visible", () => {
  const items = getNavItems("ADMIN")
  assert.deepEqual(groupNavItems(withImprimerieNavItem(items, false)), groupNavItems(items))

  const { categories } = groupNavItems(withImprimerieNavItem(items, true))
  const terrain = categories.find(({ id }) => id === "terrain")?.items.map(({ href }) => href) ?? []
  const chantier = terrain.indexOf("/chantiers")
  assert.notEqual(chantier, -1)
  assert.equal(terrain[chantier + 1], "/imprimerie")
})

test("le raccourci de chantier ouvre le dossier associé pour ses administrateurs", () => {
  const chantier = { id: env.IMPRIMERIE_WORKSITE_ID, companyId: owner.companyId }

  assert.equal(imprimerieWorksiteHref(owner, chantier, env), "/imprimerie")
  assert.equal(imprimerieWorksiteHref({ ...owner, role: "SUPER_ADMIN" }, chantier, env), "/imprimerie")
  assert.equal(imprimerieWorksiteHref(owner, { ...chantier, id: "autre-chantier" }, env), undefined)
  assert.equal(imprimerieWorksiteHref(owner, { ...chantier, companyId: "autre-entreprise" }, env), undefined)
  assert.equal(imprimerieWorksiteHref({ ...owner, companyId: "autre-entreprise" }, chantier, env), undefined)
  assert.equal(imprimerieWorksiteHref({ ...owner, role: "TEAM_LEADER" }, chantier, env), undefined)
  assert.equal(imprimerieWorksiteHref({ ...owner, role: "EMPLOYEE" }, chantier, env), undefined)
})

test("un menu sans dossier, une Preview ou un suivi désactivé ne donnent pas de raccourci", () => {
  const chantier = { id: env.IMPRIMERIE_WORKSITE_ID, companyId: owner.companyId }
  const menu = { VERCEL_ENV: "production", IMPRIMERIE_MENU_COMPANY_ID: owner.companyId }

  assert.equal(imprimerieWorksiteHref(owner, chantier, menu), undefined)
  assert.equal(imprimerieWorksiteHref(owner, chantier, { ...env, VERCEL_ENV: "preview" }), undefined)
  assert.equal(imprimerieWorksiteHref(owner, chantier, { ...env, IMPRIMERIE_PRODUCTION_ENABLED: "false" }), undefined)
})
