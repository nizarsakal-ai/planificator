// Retour 18/11/2026 : 46 factures PDF importées sans client. Données synthétiques sur le modèle des noms de fichiers réels.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { clientKey, clientNameFromFileName, existingClientByName, invoiceNumberFromFileName, isPlausibleNumber } from "@/lib/invoice-import/client-hint"
import { parseInvoiceText } from "@/lib/invoice-import/pdf-extract"
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

describe("numéro de pièce illisible (« um »)", () => {
  const own = "GALYA EVENTS"
  it("un numéro plausible contient un chiffre", () => {
    assert.equal(isPlausibleNumber("um"), false); assert.equal(isPlausibleNumber(""), false); assert.equal(isPlausibleNumber(null), false)
    assert.equal(isPlausibleNumber("F-2026-001"), true)
  })
  it("numéro repris du nom du fichier, société et date retirées", () => {
    assert.equal(invoiceNumberFromFileName("2026-03-05_2603-F-2026-001-GALYA-EVENTS.pdf", own), "2603-F-2026-001")
    assert.equal(invoiceNumberFromFileName("2026-03-16_Facture_000002_GALYA_EVENTS_HALL_EXPO.pdf", own), "000002")
    assert.equal(invoiceNumberFromFileName("2026-05-18_Facture_000010_GALYA_EVENTS_Agasf (1).pdf", own), "000010")
    assert.equal(invoiceNumberFromFileName("GALYA_EVENTS.pdf", own), "")
  })
  it("lecture du PDF : un mot sans chiffre après « Numéro » n'est jamais pris pour le numéro", () => {
    const t = parseInvoiceText("FACTURE\nNuméro um client 4521\nDate : 05/03/2026\nTotal TTC 120,00 €")
    assert.notEqual(t.number, "um")
    assert.equal(parseInvoiceText("Facture n° F-2026-001\nTotal TTC 120,00 €").number, "F-2026-001")
  })
})
