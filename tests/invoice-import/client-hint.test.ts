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

describe("facture avec remises (retour 19/11/2026, client Agasf)", () => {
  it("le « Total HT » après remise est lu, jamais le « Sous-total HT »", () => {
    const t = parseInvoiceText("Facture N° 2026-05-000010\nDate d'émission : 18/05/2026\nTente 900,00\nRemise 250,00\nSous-total HT 1 728,00 €\nRemise HT 700,40 €\nTotal HT 1 027,60 €\nTVA 20% 205,52 €\nTotal TTC 1 233,12 €")
    assert.equal(t.htCents, BigInt(102760)); assert.equal(t.vatCents, BigInt(20552)); assert.equal(t.ttcCents, BigInt(123312))
  })
  it("remise sans « Total HT » net lisible : HT = TTC − TVA", () => {
    const t = parseInvoiceText("Avoir N° 2026-08-000031\nRemise 66,00\nTotal HT 2 080,00 €\nTotal TVA 370,80 €\nTotal TTC 2 384,80 €")
    assert.equal(t.htCents, BigInt(201400)); assert.equal(t.ttcCents, BigInt(238480))
  })
  it("sans remise, des montants incohérents restent tels quels (signalés à l'aperçu)", () => {
    const t = parseInvoiceText("Facture N° F-1\nTotal HT 100,00 €\nTotal TVA 20,00 €\nTotal TTC 130,00 €")
    assert.equal(t.htCents, BigInt(10000))
  })
})
