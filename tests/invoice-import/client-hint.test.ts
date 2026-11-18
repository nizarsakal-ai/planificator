// Retour 18/11/2026 : 46 factures PDF importées sans client. Données synthétiques sur le modèle des noms de fichiers réels.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { clientKey, clientNameFromFileName, existingClientByName } from "@/lib/invoice-import/client-hint"
import { nameKey } from "@/lib/invoice-import/normalize"

describe("client lu dans le nom du fichier d'une facture", () => {
  const own = "GALYA EVENTS"
  it("date, « Facture », numéro et société émettrice retirés", () => {
    assert.equal(clientNameFromFileName("2026-06-20_Facture_000017_GALYA_EVENTS_JEDDIS_TRANSPORT.pdf", own), "JEDDIS TRANSPORT")
    assert.equal(clientNameFromFileName("2026-06-15_Facture_000015_GALYA_EVENTS_ALLO_PAREBRISE.pdf", own), "ALLO PAREBRISE")
  })
  it("suffixe de copie « (1) », chemin, casse de la société", () => {
    assert.equal(clientNameFromFileName("dossier/2026-05-18_Facture_000010_Galya_Events_Agasf (1).pdf", own), "Agasf")
  })
  it("avoir et numéro alphanumérique", () => {
    assert.equal(clientNameFromFileName("Avoir_FA-2026-004_GALYA_EVENTS_Mairie_de_Testville.pdf", own), "Mairie de Testville")
  })
  it("rien de plausible : chaîne vide (jamais un numéro ni la société seule)", () => {
    assert.equal(clientNameFromFileName("2026-06-20_Facture_000017_GALYA_EVENTS.pdf", own), "")
    assert.equal(clientNameFromFileName("000017.pdf", own), "")
  })
  it("clé identique à celle de l'analyse serveur (rapprochement des clients existants)", () => {
    for (const s of ["Société Générale SAS", "L'Atelier d'Éric", "JEDDIS  TRANSPORT"]) assert.equal(clientKey(s), nameKey(s))
  })
  it("client existant de même nom (unique) retrouvé, homonymes ignorés", () => {
    const clients = [{ id: "c1", name: "Jeddis Transport SARL" }, { id: "c2", name: "Allo Parebrise" }, { id: "c3", name: "allo parebrise" }]
    assert.equal(existingClientByName("JEDDIS TRANSPORT", clients)?.id, "c1")
    assert.equal(existingClientByName("ALLO PAREBRISE", clients), null)
    assert.equal(existingClientByName("Inconnu", clients), null)
  })
})
