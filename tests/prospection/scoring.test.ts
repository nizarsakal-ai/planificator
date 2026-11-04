/** Veille prospection — score déterministe : métier, prestation, délai, type d'avis, exclusions et plafonds. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import type { ProspectCandidate } from "@/lib/prospection/prospection.types"
import { bandForScore, scoreCandidate } from "@/lib/prospection/scoring"
import { mapBoampRecord, type BoampRecord } from "@/lib/prospection/sources/boamp.source"

const NOW = new Date("2026-11-04T06:00:00Z")
const DAY = 24 * 60 * 60 * 1000
const HERE = dirname(fileURLToPath(import.meta.url))
const records = JSON.parse(readFileSync(join(HERE, "fixtures/boamp-records.json"), "utf8")) as BoampRecord[]
const real = (id: string) => mapBoampRecord(records.find((record) => record.idweb === id) as BoampRecord) as ProspectCandidate

function tender(overrides: Partial<ProspectCandidate> = {}): ProspectCandidate {
  return {
    source: "BOAMP", sourceId: "26-1", kind: "TENDER", title: "Location, montage et démontage de chapiteaux pour la fête de la ville",
    organization: "Ville de Test", departmentCodes: ["44"], locality: null, publishedAt: new Date(NOW.getTime() - 2 * DAY),
    deadlineAt: new Date(NOW.getTime() + 20 * DAY), eventStartAt: null, eventPeriod: null, url: null, winners: [], linkedSourceIds: [],
    descriptors: [], noticeNature: "APPEL_OFFRE", reach: null, creationYear: null, ...overrides,
  }
}

function event(overrides: Partial<ProspectCandidate> = {}): ProspectCandidate {
  return {
    source: "FESTIVALS_CULTURE", sourceId: "FEST_1", kind: "EVENT", title: "Festival de test", organization: null,
    departmentCodes: ["14"], locality: "Caen", publishedAt: null, deadlineAt: null, eventStartAt: null,
    eventPeriod: "Saison (21 juin - 5 septembre)", url: null, winners: [], linkedSourceIds: [], descriptors: ["Musique"],
    noticeNature: null, reach: "Nationale", creationYear: 1998, ...overrides,
  }
}

const codes = (candidate: ProspectCandidate) => scoreCandidate(candidate, NOW).reasons.map((reason) => reason.code)

describe("scoreCandidate — appels d'offres", () => {
  it("chapiteaux + montage + 20 jours + avis de marché → 90, « À traiter »", () => {
    const result = scoreCandidate(tender(), NOW)
    assert.equal(result.band, "A_TRAITER")
    assert.deepEqual(
      result.reasons.map((reason) => [reason.code, reason.points]),
      [["METIER_CHAPITEAU", 30], ["PRESTATION_MONTAGE", 20], ["DELAI_CONFORTABLE", 25], ["AVIS_MARCHE", 15]],
    )
    assert.equal(result.score, 90)
  })

  it("chaque raison est explicable et la somme des points égale le score (borné 0..100)", () => {
    for (const candidate of [tender(), tender({ title: "Fourniture de tentes, barnums et podiums" }), real("26-99849"), event()]) {
      const result = scoreCandidate(candidate, NOW)
      const sum = result.reasons.reduce((total, reason) => total + reason.points, 0)
      assert.equal(result.score, Math.max(0, Math.min(100, sum)))
      assert.ok(result.score >= 0 && result.score <= 100)
      for (const reason of result.reasons) assert.ok(reason.label.length > 0)
    }
  })

  it("simple fourniture : pas de points de prestation ; plusieurs familles du métier cumulées", () => {
    const reasons = codes(tender({ title: "Fourniture de tentes, barnums et podiums" }))
    assert.ok(reasons.includes("PRESTATION_FOURNITURE"))
    assert.ok(reasons.includes("METIER_TENTE") && reasons.includes("METIER_BARNUM") && reasons.includes("METIER_PODIUM"))
  })

  it("délai : court (5 j) moins bien noté que confortable ; dépassé → masqué à 0", () => {
    const comfortable = scoreCandidate(tender(), NOW).score
    const short = scoreCandidate(tender({ deadlineAt: new Date(NOW.getTime() + 5 * DAY) }), NOW).score
    assert.ok(short < comfortable)
    const expired = scoreCandidate(tender({ deadlineAt: new Date(NOW.getTime() - DAY) }), NOW)
    assert.equal(expired.band, "MASQUE")
    assert.equal(expired.score, 0)
    assert.ok(expired.reasons.some((reason) => reason.code === "DELAI_DEPASSE"))
  })

  it("exclusions : achat de spectacle de cirque (avis réel d'Avion), camping, nettoyage ; annulation", () => {
    const avion = scoreCandidate(real("26-100559"), NOW)
    assert.equal(avion.band, "MASQUE")
    assert.ok(avion.reasons.some((reason) => reason.code === "EXCLU_CIRQUE_SPECTACLE"))
    assert.equal(scoreCandidate(tender({ title: "Fourniture de tentes de camping" }), NOW).band, "MASQUE")
    assert.equal(scoreCandidate(tender({ title: "Nettoyage des tribunes du stade" }), NOW).band, "MASQUE")
    assert.equal(scoreCandidate(tender({ noticeNature: "ANNULATION" }), NOW).band, "MASQUE")
    // Montage de chapiteau de cirque : ce n'est pas un achat de spectacle.
    assert.notEqual(scoreCandidate(tender({ title: "Montage d'un chapiteau pour représentations de cirque" }), NOW).band, "MASQUE")
  })

  it("travaux de bâtiment sur une tribune de stade (avis réels) : exclus ; une installation temporaire ne l'est pas", () => {
    for (const title of [
      "Travaux de rénovation de la tribune du stade Jeanne D'Arc",
      "Marché de Maîtrise d'oeuvre pour la construction d'un équipement sportif et d'une tribune couverte",
      "Travaux de réfection de la charpente et de la couverture de la tribune rugby du complexe sportif",
      "Maîtrise d'œuvre relative à la réalisation d'une couverture sur le podium - Place des fêtes",
    ]) {
      const result = scoreCandidate(tender({ title }), NOW)
      assert.equal(result.band, "MASQUE", title)
      assert.ok(result.reasons.some((reason) => reason.code === "EXCLU_BATIMENT"), title)
    }
    assert.equal(scoreCandidate(tender({ title: "Mise à disposition, montage et démontage de tribunes pour les manifestations" }), NOW).band, "A_TRAITER")
    assert.notEqual(scoreCandidate(tender({ title: "Travaux : location de gradins démontables pour la fête du stade" }), NOW).band, "MASQUE")
  })

  it("structures événementielles, location de structures, chalets, praticables : reconnus comme métier (avis réels)", () => {
    for (const title of [
      "Fourniture et installation d'une structure événementielle vitrée pour la Cité de Noël",
      "Prestations de sonorisation, d'éclairage, de vidéos & location de structures et matériels évènementiels",
      "Location de structures de loisirs, de chalets et de matériels techniques pour les fêtes solidaires",
      "Location de praticables pour la fête de la musique",
    ]) {
      assert.notEqual(scoreCandidate(tender({ title }), NOW).band, "MASQUE", title)
    }
  })

  it("« assurance » seul n'exclut pas (Caisse d'assurance maladie) ; une souscription d'assurances, si", () => {
    assert.notEqual(scoreCandidate(tender({ title: "Caisse primaire d'assurance maladie : location et montage de chapiteaux" }), NOW).band, "MASQUE")
    assert.ok(codes(tender({ title: "Souscription d'assurances pour le chapiteau municipal" })).includes("EXCLU_HORS_METIER"))
  })

  it("sans mot du métier (descripteur « Evénementiel » seul) : plafonné sous « À vérifier »", () => {
    const result = scoreCandidate(tender({ title: "Organisation du feu d'artifice du 14 juillet, installation comprise", descriptors: ["Evénementiel"] }), NOW)
    assert.equal(result.band, "MASQUE")
    assert.ok(result.score < 35)
    assert.ok(result.reasons.some((reason) => reason.code === "SANS_SIGNAL_METIER"))
  })

  it("descripteur BOAMP « Tente » sans mot du métier dans l'objet : signal suffisant pour être vérifié", () => {
    const result = scoreCandidate(tender({ title: "Prestations pour la foire exposition, installation comprise", descriptors: ["Tente"] }), NOW)
    assert.notEqual(result.band, "MASQUE")
  })
})

describe("scoreCandidate — attributions (sous-traitance)", () => {
  it("attribution réelle récente avec titulaires (Palais des Festivals de Cannes) → « À traiter »", () => {
    const result = scoreCandidate(real("26-99849"), NOW)
    assert.equal(result.band, "A_TRAITER")
    assert.ok(result.reasons.some((reason) => reason.code === "TITULAIRES_CONNUS" && reason.label.includes("HALL EXPO")))
  })

  it("sans titulaire publié et ancienne : nettement moins bien notée", () => {
    const base = real("26-99849")
    const weak = scoreCandidate({ ...base, winners: [], publishedAt: new Date(NOW.getTime() - 200 * DAY) }, NOW)
    assert.ok(weak.score < scoreCandidate(base, NOW).score - 40)
  })
})

describe("scoreCandidate — événements", () => {
  it("festival national de musique l'été, récurrent → « À traiter »", () => {
    assert.equal(scoreCandidate(event(), NOW).band, "A_TRAITER")
  })

  it("festival local de littérature au printemps → « Masqué »", () => {
    assert.equal(scoreCandidate(event({ reach: null, descriptors: ["Livre, littérature"], eventPeriod: "Avant-saison (1er janvier - 20 juin)", creationYear: 2022 }), NOW).band, "MASQUE")
  })

  it("envergure en texte libre : classée par mot-clé (internationale avant nationale, interrégionale avant régionale)", () => {
    const reach = (value: string) => scoreCandidate(event({ reach: value }), NOW).reasons[0].code
    assert.equal(reach("Nationale voir internationale"), "ENVERGURE_INTERNATIONALE")
    assert.equal(reach("Nationale"), "ENVERGURE_NATIONALE")
    assert.equal(reach("Interrrégionale"), "ENVERGURE_INTERREGIONALE")
    assert.equal(reach("Régionale/Transfrontalière"), "ENVERGURE_INTERREGIONALE")
    assert.equal(reach("régionale"), "ENVERGURE_REGIONALE")
    assert.equal(reach("Intercommunale"), "ENVERGURE_LOCALE")
  })

  it("festival d'envergure locale ou non précisée, même l'été : plafonné et masqué (la liste en compte des milliers)", () => {
    for (const reach of [null, "Intercommunale", "Départementale"]) {
      const result = scoreCandidate(event({ reach }), NOW)
      assert.equal(result.band, "MASQUE", String(reach))
      assert.ok(result.reasons.some((r) => r.code === "ENVERGURE_LOCALE_PLAFOND"), String(reach))
    }
    assert.notEqual(scoreCandidate(event({ reach: "Régionale" }), NOW).band, "MASQUE")
  })

  it("DATAtourisme : une foire ou un salon dans la bonne fenêtre → « À traiter » ; pas de plafond d'envergure", () => {
    const foire = event({ source: "DATATOURISME", reach: null, descriptors: ["FairOrShow"], eventPeriod: null, creationYear: null, eventStartAt: new Date(NOW.getTime() + 120 * DAY) })
    assert.equal(scoreCandidate(foire, NOW).band, "A_TRAITER")
  })

  it("événement daté (DATAtourisme) : passé → masqué ; entre 2 et 9 mois → bonne fenêtre", () => {
    assert.equal(scoreCandidate(event({ source: "DATATOURISME", eventStartAt: new Date(NOW.getTime() - DAY) }), NOW).band, "MASQUE")
    assert.ok(codes(event({ source: "DATATOURISME", eventStartAt: new Date(NOW.getTime() + 120 * DAY) })).includes("FENETRE_PROSPECTION"))
  })
})

describe("bandForScore", () => {
  it("seuils 60 et 35", () => {
    assert.equal(bandForScore(60), "A_TRAITER")
    assert.equal(bandForScore(59), "A_VERIFIER")
    assert.equal(bandForScore(35), "A_VERIFIER")
    assert.equal(bandForScore(34), "MASQUE")
  })

  it("déterministe : même entrée, même résultat", () => {
    assert.deepEqual(scoreCandidate(real("26-96170"), NOW), scoreCandidate(real("26-96170"), NOW))
  })
})
