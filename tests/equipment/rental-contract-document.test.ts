/** Contrat de location complet pré-établi : remplissage depuis le contrat enregistré, sans invention de données. */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { parseDay } from "@/lib/equipment/equipment.core"
import { BLANK, buildRentalContractDocument, type RentalContractDocumentInput } from "@/lib/equipment/rental-contract-document"

const d = (s: string) => parseDay(s)!
const base: RentalContractDocumentInput = {
  number: "LOC-2026-0001", status: "ACTIVE", startDate: d("2026-11-02"), endDate: d("2026-11-06"), returnedOn: null,
  dailyRateCents: 4500, fixedFeesCents: 3000, costCents: null, notes: null, createdAt: new Date("2026-11-01T10:00:00Z"),
  company: { name: "GALYA EVENTS", address: "1 rue du Port, Marseille", siret: "12345678900011", phone: null, email: "contact@galya.fr" },
  supplier: { name: "Loxam", address: null, siret: "98765432100022", vatNumber: "FR00987654321", email: null },
  equipment: { number: "MAT-012", name: "Nacelle 12 m", category: "Élévation", serialNumber: null, condition: "GOOD" },
  worksite: { name: "Salon Expo", address: "Parc Chanot" },
}
const text = (doc: ReturnType<typeof buildRentalContractDocument>) => JSON.stringify(doc).replace(/ | /g, " ")

describe("contrat de location complet", () => {
  it("remplit parties, matériel, durée, lieu et prix", () => {
    const doc = buildRentalContractDocument(base)
    assert.equal(doc.lessor.name, "Loxam")
    assert.equal(doc.lessee.name, "GALYA EVENTS")
    assert.match(doc.reference, /LOC-2026-0001/)
    const t = text(doc)
    assert.match(t, /Nacelle 12 m/)
    assert.match(t, /5 jours calendaires/)
    assert.match(t, /Salon Expo, Parc Chanot/)
    assert.match(t, /255,00 €/) // 5 × 45 € + 30 €
    assert.ok(doc.articles.length >= 15)
    assert.equal(doc.statusNote, null)
  })
  it("laisse une ligne à compléter pour toute donnée absente", () => {
    const doc = buildRentalContractDocument({ ...base, worksite: null })
    assert.ok(doc.lessor.lines.some((l) => l === `Adresse : ${BLANK}`))
    assert.equal(doc.particular.find((r) => r.label === "N° de série")?.value, BLANK)
    assert.equal(doc.particular.find((r) => r.label === "Lieu d'utilisation")?.value, BLANK)
  })
  it("ajoute la restitution et le montant définitif d'un contrat clôturé, et les notes en conditions complémentaires", () => {
    const doc = buildRentalContractDocument({ ...base, status: "CLOSED", returnedOn: d("2026-11-04"), costCents: BigInt(16500), notes: "Livraison par le loueur." })
    assert.match(doc.statusNote ?? "", /restitué/)
    assert.match(text(doc), /165,00 € \(3 jours\)/)
    assert.equal(doc.articles.at(-1)?.paragraphs[0], "Livraison par le loueur.")
  })
  it("signale un contrat annulé", () => {
    assert.match(buildRentalContractDocument({ ...base, status: "CANCELLED" }).statusNote ?? "", /annulé/i)
  })
})

describe("contrat client établi automatiquement pour une réservation", () => {
  const booking = {
    status: "RESERVED" as const, firstDay: d("2026-12-05"), lastDay: d("2026-12-06"), depositCents: 50000, checkoutCondition: null, returnedAt: null,
    createdAt: new Date("2026-11-11T10:00:00Z"), company: base.company,
    client: { name: "Mairie de Cassis", address: "Place Baragnon", siret: null, vatNumber: null, phone: null, email: "fetes@cassis.fr" },
    equipment: { number: "TENTE-01", name: "Tente pliante 3x3 m", category: "Tente", serialNumber: null, condition: "GOOD" },
    worksite: { name: "Marché de Noël", address: "Port de Cassis" }, responsible: "Sakal Nizar",
  }
  it("la société est le loueur, le client du chantier le locataire ; seule la période est saisie", async () => {
    const { buildBookingContractDocument, bookingContractNumber } = await import("@/lib/equipment/rental-contract-document")
    const doc = buildBookingContractDocument(booking)
    assert.equal(doc.lessor.name, "GALYA EVENTS")
    assert.equal(doc.lessee.name, "Mairie de Cassis")
    assert.equal(bookingContractNumber("TENTE-01", d("2026-12-05")), "LOC-TENTE-01-20261205")
    const t = text(doc)
    assert.match(t, /2 jours calendaires/)
    assert.match(t, /Marché de Noël, Port de Cassis/)
    assert.match(t, /500,00 €/)
    assert.match(t, /devis n°/)
  })
  it("sans chantier, le locataire reste à compléter", async () => {
    const { buildBookingContractDocument } = await import("@/lib/equipment/rental-contract-document")
    assert.equal(buildBookingContractDocument({ ...booking, client: null, worksite: null }).lessee.name, BLANK)
  })
})
