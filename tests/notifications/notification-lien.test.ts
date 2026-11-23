// Notifications cliquables : destination au clic (lien enregistré interne, sinon page de la catégorie, jamais d'URL externe).
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { destinationNotification, lienInterne } from "@/components/notifications/notification-lien"

describe("destination d'une notification", () => {
  it("suit le lien interne enregistré", () => {
    assert.equal(destinationNotification({ link: "/chantiers/abc", type: "WORKSITE_UPDATED" }), "/chantiers/abc")
    assert.equal(destinationNotification({ link: "/vehicules/t1?onglet=documents", type: "VEHICLE_DOCUMENT_EXPIRED" }), "/vehicules/t1?onglet=documents")
  })
  it("sans lien, ouvre la page de la catégorie", () => {
    assert.equal(destinationNotification({ link: null, type: "EXPENSE_SUBMITTED" }), "/notes-de-frais")
    assert.equal(destinationNotification({ link: null, type: "ABSENCE_APPROVED" }), "/mes-absences")
    assert.equal(destinationNotification({ type: "WORKSITE_PHOTO_UNSENT" }), "/photos-engins")
  })
  it("refuse les URL externes et retombe sur la catégorie", () => {
    for (const l of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", ""]) {
      assert.equal(lienInterne(l), null, l)
    }
    assert.equal(destinationNotification({ link: "//evil.example", type: "BOOKING_DETECTED" }), "/logements")
  })
  it("type inconnu sans lien : pas de navigation", () => {
    assert.equal(destinationNotification({ link: null, type: "INCONNU" }), null)
  })
  it("la cloche navigue au clic", () => {
    const src = readFileSync("src/components/notifications/NotificationBell.tsx", "utf8")
    assert.match(src, /onSelect=\{\(\) => handleClick\(n\)\}/)
    assert.match(src, /router\.push\(destination\)/)
  })
})
