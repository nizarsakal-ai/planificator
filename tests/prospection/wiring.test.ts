/** Veille prospection — drapeaux, menu SUPER_ADMIN, garde de page, cron quotidien et migration additive. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import { Radar } from "lucide-react"
import { getNavItems, withProspectionNavItem } from "@/lib/navigation/nav-config"
import { NAV_CATEGORY_DEFINITIONS } from "@/lib/navigation/nav-categories"
import {
  getBoampLookbackDays,
  getDatatourismeFluxUrl,
  getProspectionWatchCompanyIds,
  isProspectionNavVisible,
  isProspectionWatchEnabled,
} from "@/lib/prospection/prospection-feature-flag"
import { deadlineLabel, parseDepartmentCode, parseStatus, tabForSlug } from "@/lib/prospection/prospection-ui"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")

describe("drapeaux", () => {
  it("PROSPECTION_WATCH_ENABLED : désactivé par défaut, seule la valeur exacte « true » active", () => {
    assert.equal(isProspectionWatchEnabled({}), false)
    for (const value of ["TRUE", "1", "yes", " true", ""]) assert.equal(isProspectionWatchEnabled({ PROSPECTION_WATCH_ENABLED: value }), false)
    assert.equal(isProspectionWatchEnabled({ PROSPECTION_WATCH_ENABLED: "true" }), true)
  })

  it("sociétés, fenêtre BOAMP bornée, URL DATAtourisme en https uniquement", () => {
    assert.deepEqual(getProspectionWatchCompanyIds({ PROSPECTION_WATCH_COMPANY_IDS: " a, b,,a " }), ["a", "b"])
    assert.deepEqual(getProspectionWatchCompanyIds({}), [])
    assert.equal(getBoampLookbackDays({}), 3)
    assert.equal(getBoampLookbackDays({ PROSPECTION_WATCH_BOAMP_LOOKBACK_DAYS: "500" }), 90)
    assert.equal(getBoampLookbackDays({ PROSPECTION_WATCH_BOAMP_LOOKBACK_DAYS: "-2" }), 3)
    assert.equal(getDatatourismeFluxUrl({}), null)
    assert.equal(getDatatourismeFluxUrl({ DATATOURISME_FLUX_URL: "http://diffuseur.datatourisme.fr/x" }), null)
    assert.equal(getDatatourismeFluxUrl({ DATATOURISME_FLUX_URL: " https://diffuseur.datatourisme.fr/webservice/f/k " }), "https://diffuseur.datatourisme.fr/webservice/f/k")
  })

  it("menu visible pour SUPER_ADMIN avec société et drapeau actif, jamais pour les autres rôles", () => {
    assert.equal(isProspectionNavVisible({ enabled: true, role: "SUPER_ADMIN", companyId: "c1" }), true)
    assert.equal(isProspectionNavVisible({ enabled: false, role: "SUPER_ADMIN", companyId: "c1" }), false)
    assert.equal(isProspectionNavVisible({ enabled: true, role: "SUPER_ADMIN", companyId: " " }), false)
    for (const role of ["ADMIN", "TEAM_LEADER", "EMPLOYEE", "CLIENT", null]) {
      assert.equal(isProspectionNavVisible({ enabled: true, role, companyId: "c1" }), false, String(role))
    }
  })
})

describe("menu « Opportunités »", () => {
  it("inséré juste après « Consultations » ; invisible ⇒ liste inchangée ; idempotent", () => {
    const base = getNavItems("SUPER_ADMIN")
    assert.deepEqual(withProspectionNavItem(base, false), base)
    const shown = withProspectionNavItem(base, true)
    const index = shown.findIndex((item) => item.href === "/opportunites")
    assert.equal(shown[index - 1]?.href, "/consultations")
    assert.deepEqual(shown[index], { label: "Opportunités", href: "/opportunites", icon: Radar })
    assert.deepEqual(withProspectionNavItem(shown, true), shown)
    assert.equal(withProspectionNavItem(base, "true" as unknown as boolean).length, base.length)
  })

  it("rangé dans la catégorie Commercial, après Consultations", () => {
    const commercial = NAV_CATEGORY_DEFINITIONS.find((category) => category.id === "commercial")
    assert.deepEqual(commercial?.hrefs, ["/clients", "/consultations", "/opportunites", "/devis", "/articles"])
  })

  it("Sidebar et MobileNav composent le helper ; la visibilité est calculée côté serveur dans le layout", () => {
    for (const file of ["src/components/layout/Sidebar.tsx", "src/components/layout/MobileNav.tsx"]) {
      const src = read(file)
      assert.match(src, /withProspectionNavItem\(withHrDocumentNavItems\(/, file)
      assert.match(src, /user\.prospectionNavVisible === true\)/, file)
    }
    const layout = read("src/app/(dashboard)/layout.tsx")
    assert.match(layout, /isProspectionNavVisible\(\{ enabled: isProspectionWatchEnabled\(\), role, companyId \}\)/)
  })

  it("la page et l'action appliquent leur propre garde serveur (SUPER_ADMIN + société + drapeau)", () => {
    const page = read("src/app/(dashboard)/opportunites/page.tsx")
    assert.match(page, /role !== "SUPER_ADMIN" \|\| !companyId\) redirect\("\/dashboard"\)/)
    assert.match(page, /isProspectionNavVisible\(/)
    const action = read("src/lib/prospection/prospection.actions.ts")
    assert.match(action, /^"use server"/)
    assert.match(action, /isProspectionNavVisible\(\{ enabled: isProspectionWatchEnabled\(\)/)
    assert.match(read("src/lib/prospection/prospection.repository.ts"), /where: \{ id: input\.id, companyId: input\.companyId \}/)
  })
})

describe("aides d'affichage", () => {
  it("onglet par défaut, statut et département validés", () => {
    assert.equal(tabForSlug("inconnu").kind, "TENDER")
    assert.equal(tabForSlug("sous-traitance").kind, "AWARD")
    assert.equal(parseStatus("CONTACTE"), "CONTACTE")
    assert.equal(parseStatus("DROP TABLE"), null)
    assert.equal(parseDepartmentCode("2b"), "2B")
    assert.equal(parseDepartmentCode("999"), null)
  })

  it("libellé de date limite", () => {
    const now = new Date("2026-11-04T06:00:00Z")
    assert.equal(deadlineLabel(null, now), null)
    assert.equal(deadlineLabel(new Date("2026-11-03T06:00:00Z"), now), "Dépassée")
    assert.equal(deadlineLabel(new Date("2026-11-04T20:00:00Z"), now), "Aujourd'hui")
    assert.equal(deadlineLabel(new Date("2026-11-16T12:00:00Z"), now), "Dans 12 jours")
  })
})

describe("planification et migration", () => {
  it("cron quotidien unique, séparé de l'orchestrateur d'acquisition", () => {
    const crons = (JSON.parse(read("vercel.json")) as { crons: Array<{ path: string; schedule: string }> }).crons
    const watch = crons.filter((cron) => cron.path === "/api/cron/prospection-veille")
    assert.deepEqual(watch, [{ path: "/api/cron/prospection-veille", schedule: "0 6 * * *" }])
    const handler = read("src/lib/prospection/prospection-cron.handler.ts")
    assert.doesNotMatch(handler, /from "@\/lib\/acquisition/)
  })

  it("migration additive : une table, ses index et sa clé étrangère ; rien de supprimé ni de modifié ailleurs", () => {
    const sql = read("prisma/migrations/20261104120000_prospect_opportunities/migration.sql")
    assert.match(sql, /CREATE TABLE "prospect_opportunities"/)
    assert.doesNotMatch(sql, /\bDROP\b/i)
    assert.doesNotMatch(sql, /ALTER TABLE "(?!prospect_opportunities")/)
    assert.doesNotMatch(sql, /^\s*(UPDATE|DELETE|TRUNCATE)\b/im)
    assert.match(sql, /NON appliquée en production/)
  })

  it("aucun appel LLM ni service payant dans le module", () => {
    for (const file of [
      "src/lib/prospection/scoring.ts",
      "src/lib/prospection/prospection-watch.service.ts",
      "src/lib/prospection/prospection-cron.handler.ts",
      "src/lib/prospection/sources/boamp.source.ts",
      "src/lib/prospection/sources/festivals-culture.source.ts",
      "src/lib/prospection/sources/datatourisme.source.ts",
    ]) {
      assert.doesNotMatch(read(file), /anthropic|openai|@ai-sdk|resend|sendMail|nodemailer/i, file)
    }
  })
})
