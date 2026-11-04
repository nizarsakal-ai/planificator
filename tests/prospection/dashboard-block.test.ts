/** Veille prospection — bloc du tableau de bord SUPER_ADMIN : libellés purs, garde serveur, lectures filtrées par société. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import {
  KIND_TAB_SLUGS,
  awardedAgoLabel,
  collectedAtLabel,
  isNewOpportunity,
  isSoonDeadline,
} from "@/lib/prospection/prospection-dashboard"
import { OPPORTUNITY_TABS } from "@/lib/prospection/prospection-ui"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")

const NOW = new Date("2026-11-04T09:30:00Z") // 10 h 30 à Paris

describe("libellés du bloc", () => {
  it("dernière collecte : aujourd'hui, hier, date, ou aucune (heure de Paris)", () => {
    assert.equal(collectedAtLabel(new Date("2026-11-04T06:02:00Z"), NOW), "collecte aujourd'hui à 7 h 02")
    assert.equal(collectedAtLabel(new Date("2026-11-03T06:02:00Z"), NOW), "collecte hier à 7 h 02")
    assert.equal(collectedAtLabel(new Date("2026-11-01T06:02:00Z"), NOW), "collecte du 1 nov. à 7 h 02")
    assert.equal(collectedAtLabel(null, NOW), "aucune collecte pour l'instant")
  })

  it("le libellé ne prétend jamais au temps réel", () => {
    for (const label of [collectedAtLabel(NOW, NOW), collectedAtLabel(null, NOW)]) assert.doesNotMatch(label, /temps réel|en direct/i)
  })

  it("attribution : aujourd'hui, hier, il y a n jours", () => {
    assert.equal(awardedAgoLabel(new Date("2026-11-04T08:00:00Z"), NOW), "Attribué aujourd'hui")
    assert.equal(awardedAgoLabel(new Date("2026-11-03T08:00:00Z"), NOW), "Attribué hier")
    assert.equal(awardedAgoLabel(new Date("2026-10-29T08:00:00Z"), NOW), "Attribué il y a 6 jours")
    assert.equal(awardedAgoLabel(null, NOW), null)
  })

  it("échéance proche : moins de 10 jours, jamais une échéance dépassée", () => {
    assert.equal(isSoonDeadline(new Date("2026-11-13T09:00:00Z"), NOW), true)
    assert.equal(isSoonDeadline(new Date("2026-11-22T09:00:00Z"), NOW), false)
    assert.equal(isSoonDeadline(new Date("2026-11-01T09:00:00Z"), NOW), false)
    assert.equal(isSoonDeadline(null, NOW), false)
  })

  it("nouvelle piste : apparue lors des dernières 24 heures", () => {
    assert.equal(isNewOpportunity(new Date("2026-11-03T10:00:00Z"), NOW), true)
    assert.equal(isNewOpportunity(new Date("2026-11-03T09:00:00Z"), NOW), false)
  })

  it("chaque type renvoie vers un onglet existant de /opportunites", () => {
    for (const [kind, slug] of Object.entries(KIND_TAB_SLUGS)) {
      assert.equal(OPPORTUNITY_TABS.find((tab) => tab.slug === slug)?.kind, kind)
    }
  })
})

describe("garde et lectures", () => {
  const page = read("src/app/(dashboard)/dashboard/page.tsx")
  const repo = read("src/lib/prospection/prospection-dashboard.repository.ts")
  const block = read("src/components/dashboard/ProspectionBlock.tsx")

  it("le tableau de bord n'affiche le bloc qu'avec drapeau serveur + SUPER_ADMIN + société", () => {
    assert.match(page, /isProspectionNavVisible\(\{ enabled: isProspectionWatchEnabled\(\), role, companyId \}\)/)
    assert.match(page, /prospectionCompanyId=\{prospectionVisible && companyId \? companyId : null\}/)
    assert.match(page, /\{prospectionCompanyId && <ProspectionBlock companyId=\{prospectionCompanyId\} \/>\}/)
    // Le bloc n'est rendu que dans la branche SUPER_ADMIN.
    assert.equal(page.match(/<ProspectionBlock/g)?.length, 1)
  })

  it("toutes les lectures sont filtrées par companyId, en lecture seule", () => {
    assert.match(repo, /companyId,\s*\n\s*band: \{ in: \["A_TRAITER", "A_VERIFIER"\] \}/)
    assert.match(repo, /countOpportunitiesByKind\(companyId, now\)/)
    assert.match(repo, /aggregate\(\{ where: \{ companyId \}/)
    assert.doesNotMatch(repo, /\.(create|update|upsert|delete)(Many)?\(/)
  })

  it("mêmes règles que la page : hors Écarté / Perdu, appels d'offres clos exclus, priorité puis score", () => {
    assert.match(repo, /status: \{ notIn: \["ECARTE", "PERDU"\] \}/)
    assert.match(repo, /\{ kind: \{ not: "TENDER" \} \}, \{ deadlineAt: null \}, \{ deadlineAt: \{ gte: now \} \}/)
    assert.match(repo, /orderBy: \[\{ priorityGroup: "asc" \}, \{ score: "desc" \}/)
  })

  it("mention des sources (Licence Ouverte) et aucun envoi automatique", () => {
    assert.match(block, /SOURCE_ATTRIBUTION/)
    assert.match(block, /Rien n&apos;est envoyé automatiquement/)
  })
})
