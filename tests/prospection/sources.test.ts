/** Veille prospection — festivals (CSV Culture) et DATAtourisme : mapping, données personnelles écartées, désactivation. */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  departmentFromPostalCode,
  fetchDatatourismeCandidates,
  mapDatatourismePayload,
} from "@/lib/prospection/sources/datatourisme.source"
import { departmentCodeFromName } from "@/lib/prospection/sources/departments"
import { fetchFestivalCandidates, mapFestivalsCsv, parseSemicolonCsv } from "@/lib/prospection/sources/festivals-culture.source"

// En-tête réel du jeu de données (double BOM compris) ; lignes fictives.
const HEADER =
  "﻿﻿Nom du festival;Envergure territoriale;Région principale de déroulement;Département principal de déroulement;Commune principale de déroulement;Code postal (de la commune principale de déroulement);Code Insee commune;Code Insee EPCI;Libellé EPCI;Numéro de voie;Type de voie (rue, Avenue, boulevard, etc.);Nom de la voie;Adresse postale;Complément d'adresse (facultatif);Site internet du festival;Adresse e-mail;Décennie de création du festival;Année de création du festival;Discipline dominante;Sous-catégorie spectacle vivant;Sous-catégorie musique;Sous-catégorie Musique CNM;Sous-catégorie cinéma et audiovisuel;Sous-catégorie arts visuels et arts numériques;Sous-catégorie livre et littérature;Période principale de déroulement du festival;Identifiant Agence A;Identifiant;Géocodage xy;identifiant CNM"
const ROW_1 =
  'Festival Test; Nationale ;Bretagne;Finistère;Carhaix-Plouguer;29270;29024;;;12;Rue;des Tests;12 Rue des Tests;;www.festival-test.fr;jeanne.dupont@exemple.fr;De 1990 à 1999;1992;Musique;;"Pop, rock; électro";;;;;Saison (21 juin - 5 septembre);;FEST_29024_1;48.27, -3.57;'
const ROW_2 = "Sans identifiant;;;Paris;Paris;75001;;;;;;;;;;contact@exemple.fr;;;Cinéma;;;;;;;Après-saison;;;;"
const CSV = [HEADER, ROW_1, ROW_2, ""].join("\r\n")

describe("liste des festivals (ministère de la Culture)", () => {
  it("parseSemicolonCsv : guillemets, point-virgule protégé, CRLF, BOM", () => {
    const rows = parseSemicolonCsv(CSV)
    assert.equal(rows.length, 3)
    assert.equal(rows[0][0], "Nom du festival")
    assert.equal(rows[1][20], "Pop, rock; électro")
  })

  it("mapping : nom, commune, département, période, discipline, envergure, année, site ; ligne sans identifiant écartée", () => {
    const [festival, ...rest] = mapFestivalsCsv(CSV)
    assert.equal(rest.length, 0)
    assert.equal(festival.source, "FESTIVALS_CULTURE")
    assert.equal(festival.sourceId, "FEST_29024_1")
    assert.equal(festival.kind, "EVENT")
    assert.deepEqual(festival.departmentCodes, ["29"])
    assert.equal(festival.locality, "Carhaix-Plouguer")
    assert.equal(festival.reach, "Nationale")
    assert.equal(festival.creationYear, 1992)
    assert.equal(festival.url, "https://www.festival-test.fr/")
    assert.equal(festival.eventPeriod, "Saison (21 juin - 5 septembre)")
  })

  it("RGPD : ni e-mail ni adresse postale dans les fiches produites", () => {
    const serialized = JSON.stringify(mapFestivalsCsv(CSV))
    assert.ok(!serialized.includes("@"), "aucun e-mail")
    assert.ok(!serialized.includes("jeanne"), "aucun nom de personne")
    assert.ok(!serialized.includes("Rue des Tests"), "aucune adresse postale")
  })

  it("départements par nom, y compris Corse et outre-mer", () => {
    assert.equal(departmentCodeFromName("Côtes-d'Armor"), "22")
    assert.equal(departmentCodeFromName("corse du sud"), "2A")
    assert.equal(departmentCodeFromName("La Réunion"), "974")
    assert.equal(departmentCodeFromName("Inconnu"), null)
  })

  it("fetchFestivalCandidates : résout le CSV courant via l'API data.gouv", async () => {
    const urls: string[] = []
    const fakeFetch = (async (url: string) => {
      urls.push(url)
      if (url.includes("/api/1/datasets/")) {
        return new Response(JSON.stringify({ resources: [{ format: "gpkg", url: "https://x/f.gpkg" }, { format: "csv", url: "https://static.data.gouv.fr/f.csv" }] }))
      }
      return new Response(CSV)
    }) as unknown as typeof fetch
    const candidates = await fetchFestivalCandidates({ fetchImpl: fakeFetch })
    assert.equal(candidates.length, 1)
    assert.equal(urls[1], "https://static.data.gouv.fr/f.csv")
  })
})

describe("DATAtourisme", () => {
  it("désactivé sans URL de flux : aucun appel réseau", async () => {
    let called = false
    const fakeFetch = (async () => {
      called = true
      return new Response("[]")
    }) as unknown as typeof fetch
    const result = await fetchDatatourismeCandidates({ fluxUrl: null, fetchImpl: fakeFetch })
    assert.deepEqual(result, { status: "DISABLED", candidates: [] })
    assert.equal(called, false)
  })

  it("mapping défensif JSON-LD : événement retenu, lieu sans type événement ignoré, contacts jamais lus", () => {
    const payload = {
      "@graph": [
        {
          "@id": "https://data.datatourisme.fr/13/abc",
          "dc:identifier": "FMAPDL0440001",
          "@type": ["schema:Event", "EntertainmentAndEvent", "FairOrShow", "PointOfInterest"],
          "rdfs:label": { fr: ["Foire de Nantes"] },
          takesPlaceAt: [{ startDate: "2027-05-01", endDate: "2027-05-09" }],
          isLocatedAt: [{ "schema:address": [{ "schema:postalCode": "44300", "schema:addressLocality": "Nantes" }] }],
          hasContact: [{ "schema:email": ["prenom.nom@exemple.fr"], "schema:familyName": ["Nom"] }],
        },
        { "@id": "https://data.datatourisme.fr/13/def", "@type": ["PlaceOfInterest"], "rdfs:label": { fr: ["Musée"] } },
      ],
    }
    const [foire, ...rest] = mapDatatourismePayload(payload)
    assert.equal(rest.length, 0)
    assert.equal(foire.source, "DATATOURISME")
    assert.equal(foire.sourceId, "FMAPDL0440001")
    assert.equal(foire.title, "Foire de Nantes")
    assert.deepEqual(foire.departmentCodes, ["44"])
    assert.equal(foire.locality, "Nantes")
    assert.equal(foire.eventStartAt?.toISOString(), "2027-05-01T00:00:00.000Z")
    assert.match(foire.eventPeriod ?? "", /^Du 1 mai 2027 au 9 mai 2027$/)
    assert.deepEqual(foire.descriptors, ["EntertainmentAndEvent", "FairOrShow"])
    assert.ok(!JSON.stringify(foire).includes("@exemple.fr"))
  })

  it("code postal → département (Corse, outre-mer)", () => {
    assert.equal(departmentFromPostalCode("20000"), "2A")
    assert.equal(departmentFromPostalCode("20200"), "2B")
    assert.equal(departmentFromPostalCode("97400"), "974")
    assert.equal(departmentFromPostalCode("7500"), null)
  })

  it("erreur HTTP : le message ne reprend jamais l'URL du flux (elle contient la clé)", async () => {
    const failing = (async () => new Response("", { status: 403 })) as unknown as typeof fetch
    await assert.rejects(
      fetchDatatourismeCandidates({ fluxUrl: "https://diffuseur.datatourisme.fr/webservice/flux/CLE-SECRETE", fetchImpl: failing }),
      (error: Error) => error.message === "DATATOURISME_HTTP_403" && !error.message.includes("CLE-SECRETE"),
    )
  })
})
