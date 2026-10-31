/** SPEC-WORKSITE-PHOTOS-001 Lot 3 — rendu statique de la vue Photos engins (sans navigateur). */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React, { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { PhotosEnginsView, type PhotoListItem, type PhotosContext } from "@/components/worksite-photos/PhotosEnginsView"

// tsconfig "jsx": "preserve" → sous tsx, le JSX est compilé en React.createElement (runtime classique).
;(globalThis as { React?: typeof React }).React = React

const context: PhotosContext = {
  role: "EMPLOYEE",
  worksites: [{ id: "w1", name: "Chantier A", clientName: "Lauralu", status: "IN_PROGRESS" }, { id: "w2", name: "Chantier B", clientName: "Autre", status: "PLANNED" }],
  trucks: [{ id: "t1", matricule: "AA-111-AA" }],
}
const photos: PhotoListItem[] = [
  { id: "p1", worksiteId: "w1", truckId: "t1", phase: "BEFORE", status: "PENDING", drivePath: "/Chantiers/Lauralu-Chantier A~w1/2026-10-30/x.jpg", originalFilename: "IMG_1.jpg", sizeBytes: 1_200_000, uploadedAt: "2026-10-30T09:00:00.000Z", uploadedByName: "Eva Ouvrière", sentAt: null },
  { id: "p2", worksiteId: "w1", truckId: "t1", phase: "AFTER", status: "SENT", drivePath: "/Chantiers/Lauralu-Chantier A~w1/2026-10-30/y.jpg", originalFilename: "IMG_2.jpg", sizeBytes: 900_000, uploadedAt: "2026-10-30T10:00:00.000Z", uploadedByName: "Eva Ouvrière", sentAt: "2026-10-30T12:00:00.000Z" },
]

describe("PhotosEnginsView", () => {
  it("sélecteurs, phase, entrée caméra masquée, liste avec statuts et vignettes via le proxy, aucun identifiant Drive", () => {
    const html = renderToStaticMarkup(createElement(PhotosEnginsView, { context, initialPhotos: photos }))
    assert.match(html, /Lauralu/)
    assert.match(html, /Chantier B/)
    assert.match(html, /AA-111-AA/)
    assert.match(html, /role="radiogroup"[^>]*aria-label="Phase"/)
    assert.match(html, /type="file"[^>]*accept="image\/jpeg,image\/png"[^>]*capture="environment"/)
    // LOT-ADMIN-REVIEW : le statut d'envoi est un constat (« Non envoyée »), sans promesse d'envoi automatique au client.
    assert.match(html, /Non envoyée/)
    assert.equal(/En attente d(&#x27;|')envoi|transmises? au client|Hermes/.test(html), false)
    assert.match(html, /Envoyée au client/)
    assert.match(html, /src="\/api\/worksite-photos\/p1\/file"/)
    assert.match(html, /src="\/api\/worksite-photos\/p2\/file"/)
    assert.equal(/drive\.google|googleapis|driveFileId/.test(html), false)
  })
  it("photos supprimées avant ou après envoi : libellés distincts, aucune vignette (fichier en corbeille)", () => {
    const removed: PhotoListItem[] = [
      { ...photos[0], id: "p3", status: "REJECTED" },
      { ...photos[1], id: "p4", status: "DELETED" },
    ]
    const html = renderToStaticMarkup(createElement(PhotosEnginsView, { context, initialPhotos: removed }))
    assert.match(html, /Supprimée avant envoi/)
    assert.match(html, /Supprimée après envoi/)
    assert.equal(/\/api\/worksite-photos\/p3\/file|\/api\/worksite-photos\/p4\/file/.test(html), false)
  })
  it("liste vide ⇒ message ; aucun chantier visible ⇒ prise de vue impossible", () => {
    const html = renderToStaticMarkup(createElement(PhotosEnginsView, { context: { ...context, worksites: [] }, initialPhotos: [] }))
    assert.match(html, /Aucune photo pour l(&#x27;|')instant/)
    assert.match(html, /<button[^>]*disabled/)
  })
})
