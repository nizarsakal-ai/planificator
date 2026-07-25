import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  decodeHtmlEntities,
  normalizeBookingDisplayText,
  normalizeBookingDisplayTextOrNull,
  stripResidualHtmlTags,
} from "@/lib/booking/normalize-booking-display-text"

describe("normalizeBookingDisplayText", () => {
  it("supprime les balises résiduelles comme </title>", () => {
    assert.equal(
      normalizeBookingDisplayText("Hôtel Central</title>"),
      "Hôtel Central"
    )
    assert.equal(stripResidualHtmlTags("A</title>B<title>C"), "A B C")
  })

  it("décode &#39; en apostrophe", () => {
    assert.equal(
      normalizeBookingDisplayText("L&#39;Auberge du Port"),
      "L'Auberge du Port"
    )
  })

  it("décode &amp; et &quot;", () => {
    assert.equal(
      normalizeBookingDisplayText("Bar &amp; Grill &quot;Sunset&quot;"),
      'Bar & Grill "Sunset"'
    )
  })

  it("décode entités hex et numériques", () => {
    assert.equal(decodeHtmlEntities("&#x27;"), "'")
    assert.equal(decodeHtmlEntities("&#34;"), '"')
  })

  it("conserve les accents et un texte déjà propre", () => {
    const clean = "Résidence Côte d'Azur — été"
    assert.equal(normalizeBookingDisplayText(clean), clean)
  })

  it("trim et collapse les espaces après strip", () => {
    assert.equal(
      normalizeBookingDisplayText("  Villa <b>Rosa</b>   "),
      "Villa Rosa"
    )
  })

  it("nullable : vide → null", () => {
    assert.equal(normalizeBookingDisplayTextOrNull(null), null)
    assert.equal(normalizeBookingDisplayTextOrNull("   "), null)
    assert.equal(normalizeBookingDisplayTextOrNull("</title>"), null)
    assert.equal(normalizeBookingDisplayTextOrNull("OK"), "OK")
  })

  it("cas combiné type popup (nom + snippet)", () => {
    const hotel = normalizeBookingDisplayText("Maison d&#39;hôtes</title>")
    const snippet = normalizeBookingDisplayText(
      "Réservation confirmée &amp; payée &#39;OK&#39;"
    )
    assert.equal(hotel, "Maison d'hôtes")
    assert.equal(snippet, "Réservation confirmée & payée 'OK'")
  })
})
