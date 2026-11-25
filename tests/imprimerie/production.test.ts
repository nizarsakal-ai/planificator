import assert from "node:assert/strict"
import { test } from "node:test"
import { imprimerieProductionDossier, PRINT_MANAGER_STUDIO_URL } from "../../src/lib/imprimerie/production"
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

test("Imprimerie se place après Chantiers uniquement lorsque le dossier est visible", () => {
  const items = getNavItems("ADMIN")
  assert.deepEqual(groupNavItems(withImprimerieNavItem(items, false)), groupNavItems(items))

  const { categories } = groupNavItems(withImprimerieNavItem(items, true))
  const terrain = categories.find(({ id }) => id === "terrain")?.items.map(({ href }) => href) ?? []
  const chantier = terrain.indexOf("/chantiers")
  assert.notEqual(chantier, -1)
  assert.equal(terrain[chantier + 1], "/imprimerie")
})
