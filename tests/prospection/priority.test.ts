/** Veille prospection — ordre de priorité de Nizar, marchés clos à recontacter et aides d'affichage. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import {
  isRecentlyClosedWorthRecontact,
  isTownHall,
  priorityGroupsFor,
  priorityRankFor,
} from "@/lib/prospection/priority"
import { departmentsLabel, sentenceCase } from "@/lib/prospection/prospection-ui"
import type { ScoreReason } from "@/lib/prospection/prospection.types"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
const NOW = new Date("2026-11-04T06:00:00Z")
const DAY = 24 * 60 * 60 * 1000

const rank = (organization: string | null, title: string, departmentCodes: string[]) => priorityRankFor({ organization, title, departmentCodes })

describe("priorityRankFor — ordre de Nizar", () => {
  it("1 : mairies, villes, communes, CCAS de Paris et d'Île-de-France (avis réels)", () => {
    assert.equal(rank("Ville de Stains", "Location de structures de loisirs et de chalets", ["93"]), 1)
    assert.equal(rank("Mairie de Roissy-en-France", "Renouvellement de la tribune télescopique", ["95"]), 1)
    assert.equal(rank("Mairie de Paris Direction de la Jeunesse", "Centres Paris Anim'", ["75"]), 1)
    assert.equal(rank("CCAS de Sèvres", "Prestations pour les événements du CCAS", ["92", "75"]), 1)
  })

  it("2 : montage ou démontage en Île-de-France, hors mairie (avis réel du CNC)", () => {
    assert.equal(rank("Centre national du cinéma", "Conception, installation et démontage de stands", ["06", "63", "74", "75"]), 2)
    assert.equal(rank("Paris Musées", "Montage d'un chapiteau pour le gala", ["75"]), 2)
  })

  it("3 : autres pistes en Île-de-France ; une mairie hors Île-de-France n'est pas prioritaire", () => {
    assert.equal(rank("EPPGHV", "Location de structures de spectacle", ["75", "77", "78", "91", "92", "93", "94", "95"]), 3)
    assert.equal(rank("Ville de Nice", "Montage et démontage de tribunes", ["06"]), 5)
  })

  it("4 : départements limitrophes ; 5 : reste de la France, ou département inconnu", () => {
    assert.equal(rank("CCI Marne Ardennes", "Festival des entrepreneurs", ["08", "51"]), 4)
    assert.equal(rank("Conseil départemental d'Eure-et-Loir", "Location de structures", ["28"]), 4)
    assert.equal(rank("Mairie d'Aubagne", "Location de structures CTS", ["13"]), 5)
    assert.equal(rank(null, "Festival", []), 5)
  })

  it("isTownHall : sans faux positif sur un établissement public ou un département", () => {
    assert.equal(isTownHall("Mairie d'Ivry-sur-Seine"), true)
    assert.equal(isTownHall("COMMUNE DE BRUNOY"), true)
    assert.equal(isTownHall("Département des Hauts-de-Seine"), false)
    assert.equal(isTownHall("Etablissement Public Territorial Paris Terres d'Envol"), false)
    assert.equal(isTownHall(null), false)
  })

  it("événements : trois groupes seulement (Île-de-France, voisins, reste)", () => {
    assert.deepEqual(priorityGroupsFor("EVENT").map((g) => [g.rank, g.label]), [[3, "Île-de-France"], [4, "Départements voisins"], [5, "Reste de la France"]])
    assert.equal(priorityGroupsFor("TENDER").length, 5)
  })
})

describe("isRecentlyClosedWorthRecontact", () => {
  const trade: ScoreReason[] = [{ code: "METIER_MATERIEL_EVENEMENTIEL", label: "x", points: 30 }, { code: "DELAI_DEPASSE", label: "x", points: 0 }]
  const base = { kind: "TENDER", priorityGroup: 1, band: "MASQUE", reasons: trade, deadlineAt: new Date(NOW.getTime() - 7 * DAY) }

  it("mairie d'Île-de-France close il y a 7 jours avec un mot du métier (Bondy) → à recontacter", () => {
    assert.equal(isRecentlyClosedWorthRecontact(base, NOW), true)
    assert.equal(isRecentlyClosedWorthRecontact({ ...base, band: "A_TRAITER", reasons: [] }, NOW), true, "retenue avant l'échéance")
  })

  it("écartée : encore ouverte, close depuis plus de 60 jours, groupe 3 et plus, hors métier, exclue ou annulée", () => {
    assert.equal(isRecentlyClosedWorthRecontact({ ...base, deadlineAt: new Date(NOW.getTime() + DAY) }, NOW), false)
    assert.equal(isRecentlyClosedWorthRecontact({ ...base, deadlineAt: new Date(NOW.getTime() - 61 * DAY) }, NOW), false)
    assert.equal(isRecentlyClosedWorthRecontact({ ...base, priorityGroup: 3 }, NOW), false)
    assert.equal(isRecentlyClosedWorthRecontact({ ...base, reasons: [{ code: "SANS_SIGNAL_METIER", label: "x", points: -10 }] }, NOW), false)
    assert.equal(isRecentlyClosedWorthRecontact({ ...base, reasons: [...trade, { code: "EXCLU_BATIMENT", label: "x", points: 0 }] }, NOW), false)
    assert.equal(isRecentlyClosedWorthRecontact({ ...base, kind: "AWARD" }, NOW), false)
    assert.equal(isRecentlyClosedWorthRecontact({ ...base, deadlineAt: null }, NOW), false)
  })
})

describe("aides d'affichage", () => {
  it("departmentsLabel : Île-de-France complète, sinon deux codes et le reste en compte", () => {
    assert.equal(departmentsLabel(["75", "77", "78", "91", "92", "93", "94", "95"]), "Île-de-France")
    assert.equal(departmentsLabel(["08", "51"]), "08, 51")
    assert.equal(departmentsLabel(["29", "33", "34", "54"]), "29, 33 +2")
  })

  it("sentenceCase : titres tout en majuscules seulement", () => {
    assert.equal(sentenceCase("LOCATION DE STRUCTURES (TYPE CTS)"), "Location de structures (type cts)")
    assert.equal(sentenceCase("Location de chapiteaux à Paris"), "Location de chapiteaux à Paris")
  })
})

describe("câblage", () => {
  it("la migration crée la colonne de priorité et son index ; le dépôt trie par priorité puis score et masque les marchés clos", () => {
    const sql = read("prisma/migrations/20261104120000_prospect_opportunities/migration.sql")
    assert.match(sql, /"priorityGroup" INTEGER NOT NULL DEFAULT 5/)
    assert.match(sql, /CREATE INDEX "prospect_opportunities_companyId_kind_priorityGroup_score_idx"/)
    const repo = read("src/lib/prospection/prospection.repository.ts")
    assert.match(repo, /\{ priorityGroup: "asc" \},\n\s+\.\.\.\(filters\.kind === "TENDER"/)
    assert.match(repo, /priorityGroup: priorityRankFor\(candidate\)/)
    assert.match(repo, /OR: \[\{ deadlineAt: null \}, \{ deadlineAt: \{ gte: now \} \}\]/)
  })

  it("la CI exécute les tests de la veille prospection", () => {
    assert.match(read(".github/workflows/lot-c-release.yml"), /test:navigation test:database test:prospection; do/)
  })
})
