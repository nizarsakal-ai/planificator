/** LOT-ADMIN-REVIEW — rendu statique de la galerie de contrôle et du détail (données fictives, sans navigateur). */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React, { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { PhotoReviewDetail, PhotosReviewGallery, actionsFor, canStartMutation, detailAfterRefresh, matchesFilter, type ReviewItem } from "@/components/worksite-photos/PhotosReviewGallery"
import { PhotosEnginsView } from "@/components/worksite-photos/PhotosEnginsView"

;(globalThis as { React?: typeof React }).React = React

const T = "2026-10-31T08:00:00.000Z"
function item(id: string, over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id, worksite: { id: "w1", name: "Chantier test", clientName: "Client test" }, truck: { id: "t1", matricule: "ZZ-000-ZZ" }, phase: "BEFORE", status: "PENDING",
    uploadedAt: T, uploadedByName: "Ouvrier test",
    approval: { state: "TO_REVIEW", at: null, byName: null }, delivery: { state: "NOT_SENT", sentAt: null },
    deletion: { state: "NONE", path: null, requestedAt: null, byName: null, doneAt: null }, ...over,
  }
}
const approved = item("pa", { approval: { state: "APPROVED", at: T, byName: "Super Admin test" } })
const legacySent = item("ps", { status: "SENT", approval: { state: "NOT_TRACKED", at: null, byName: null }, delivery: { state: "SENT", sentAt: T } })
const toResume = item("pr", { deletion: { state: "TO_RESUME", path: "REJECT", requestedAt: T, byName: "Super Admin test", doneAt: null } })
const rejected = item("px", { status: "REJECTED", approval: { state: "NOT_APPROVED", at: null, byName: null }, deletion: { state: "TRASHED", path: "REJECT", requestedAt: T, byName: "Super Admin test", doneAt: T } })
const deleted = item("pd", { status: "DELETED", approval: { state: "NOT_TRACKED", at: null, byName: null }, delivery: { state: "SENT", sentAt: T }, deletion: { state: "TRASHED", path: "TRASH", requestedAt: T, byName: "Super Admin test", doneAt: T } })
const noop = () => undefined
const detail = (photo: ReviewItem, confirming = false) => renderToStaticMarkup(createElement(PhotoReviewDetail, { photo, busy: null, confirming, onApprove: noop, onAskTrash: noop, onConfirmTrash: noop, onCancelTrash: noop }))

describe("galerie de contrôle", () => {
  it("vignettes via le proxy, commandes Voir / Valider / Supprimer / Reprendre visibles, filtres, Charger plus ; aucune donnée Drive", () => {
    const html = renderToStaticMarkup(createElement(PhotosReviewGallery, {
      worksites: [{ id: "w1", name: "Chantier test", clientName: "Client test" }],
      initialPage: { photos: [item("p1"), legacySent, toResume, rejected], nextCursor: "c" },
    }))
    assert.match(html, /Contrôle des photos/)
    assert.match(html, /src="\/api\/worksite-photos\/p1\/file"/)
    assert.equal(/\/api\/worksite-photos\/px\/file/.test(html), false, "photo en corbeille : aucune vignette")
    assert.match(html, />Voir</)
    assert.match(html, /Valider/)
    assert.match(html, /Supprimer/)
    assert.match(html, /Reprendre/)
    assert.match(html, /Suppression à reprendre/)
    assert.match(html, /Charger plus/)
    assert.match(html, /role="tablist"/)
    assert.match(html, /h-11 w-full min-w-0/, "boutons pleine largeur, cible 44 px")
    assert.match(html, /xl:grid xl:grid-cols-2/, "commandes côte à côte seulement à partir de xl")
    assert.equal(/lg:grid lg:grid-cols-2/.test(html), false, "commandes encore empilées au seuil lg")
    assert.match(html, /Actualiser/, "relecture manuelle toujours disponible")
    assert.equal(/drive-|driveFileId|drivePath|googleapis|Hermes/.test(html), false)
  })
  it("commandes selon l'état", () => {
    assert.deepEqual(actionsFor(item("p1")), { approve: true, trash: true, resume: false })
    assert.deepEqual(actionsFor(approved), { approve: false, trash: true, resume: false })
    assert.deepEqual(actionsFor(legacySent), { approve: false, trash: true, resume: false })
    assert.deepEqual(actionsFor(toResume), { approve: false, trash: false, resume: true })
    assert.deepEqual(actionsFor(rejected), { approve: false, trash: false, resume: false })
  })
  it("synchronisation au filtre : validée sort de « À valider », supprimée sort de « Validées »", () => {
    assert.equal(matchesFilter(item("p1"), "TO_REVIEW", ""), true)
    assert.equal(matchesFilter(approved, "TO_REVIEW", ""), false)
    assert.equal(matchesFilter(approved, "APPROVED", ""), true)
    assert.equal(matchesFilter({ ...approved, status: "REJECTED", deletion: rejected.deletion }, "APPROVED", ""), false)
    assert.equal(matchesFilter(toResume, "TO_RESUME", ""), true)
    assert.equal(matchesFilter(deleted, "REMOVED", ""), true)
    assert.equal(matchesFilter(deleted, "SENT", ""), false)
    assert.equal(matchesFilter(item("p1"), "ALL", "w2"), false)
  })
})

describe("détail : deux dimensions distinctes et actions", () => {
  it("à valider : aperçu agrandi, « Non envoyée » sans promesse, Valider et Supprimer", () => {
    const html = detail(item("p1"))
    assert.match(html, /src="\/api\/worksite-photos\/p1\/file"/)
    assert.match(html, /aria-label="Validation interne"/)
    assert.match(html, /aria-label="Envoi au client"/)
    assert.match(html, /À valider/)
    assert.match(html, /aucun envoi automatique n(&#x27;|')est actif/)
    assert.match(html, />.*Valider/)
    assert.match(html, /Supprimer/)
  })
  it("SENT legacy : validation « non tracée », envoi avec preuve, suppression possible sans requalification", () => {
    const html = detail(legacySent)
    assert.match(html, /Non tracée \(antérieure au contrôle\)/)
    assert.match(html, /preuve de transport enregistrée/)
    assert.equal(/Valider/.test(html), false, "aucune validation proposée après envoi")
    assert.match(detail(legacySent, true), /La preuve d(&#x27;|')envoi est conservée/)
  })
  it("suppression à reprendre : alerte et bouton Reprendre ; en corbeille : aucune action, chemin lisible", () => {
    const resume = detail(toResume)
    assert.match(resume, /role="alert"/)
    assert.match(resume, /Reprendre la suppression/)
    const trashed = detail(rejected)
    assert.match(trashed, /Supprimée avant envoi/)
    assert.equal(/Valider|Supprimer<|Reprendre/.test(trashed), false)
    assert.match(detail(deleted), /Supprimée après envoi/)
  })
  it("confirmation avant envoi : corbeille récupérable, plus de validation ni d'envoi possibles", () => {
    const html = detail(item("p1"), true)
    assert.match(html, /Mettre à la corbeille/)
    assert.match(html, /Supprimée avant envoi/)
    assert.match(html, /30 jours/)
  })
})

describe("admission des actions : jamais pendant une lecture ni deux fois", () => {
  it("chargement en cours, action en cours ou double appui ⇒ refus ; sinon autorisé", () => {
    assert.equal(canStartMutation({ loading: false, busy: null, inFlight: false }), true)
    assert.equal(canStartMutation({ loading: true, busy: null, inFlight: false }), false, "pendant Chargement / Charger plus / Actualiser")
    assert.equal(canStartMutation({ loading: false, busy: "trash", inFlight: false }), false, "autre action en cours")
    assert.equal(canStartMutation({ loading: false, busy: null, inFlight: true }), false, "double appui avant le rendu suivant")
  })
  it("détail verrouillé : Valider, Supprimer et Reprendre désactivés, sans indicateur de chargement trompeur", () => {
    const render = (photo: ReviewItem, confirming = false) => renderToStaticMarkup(createElement(PhotoReviewDetail, { photo, busy: null, locked: true, confirming, onApprove: noop, onAskTrash: noop, onConfirmTrash: noop, onCancelTrash: noop }))
    for (const html of [render(item("p1")), render(toResume), render(item("p1"), true)]) {
      const buttons = html.match(/<button[^>]*>/g) ?? []
      assert.ok(buttons.length > 0)
      assert.ok(buttons.every((b) => /disabled=""/.test(b)), "toutes les commandes désactivées")
      assert.equal(/animate-spin/.test(html), false)
    }
  })
})

describe("relecture après échec", () => {
  it("intention récupérée ⇒ confirmation fermée, « Reprendre la suppression » visible aussitôt, alerte levée", () => {
    const next = detailAfterRefresh("pr", [item("p1"), toResume])
    assert.equal(next.confirming, false)
    assert.equal(next.stale, false)
    assert.equal(next.fresh?.deletion.state, "TO_RESUME")
    const html = renderToStaticMarkup(createElement(PhotoReviewDetail, { photo: next.fresh!, busy: null, confirming: next.confirming, onApprove: noop, onAskTrash: noop, onConfirmTrash: noop, onCancelTrash: noop }))
    assert.match(html, /Reprendre la suppression/)
    assert.equal(/Mettre à la corbeille/.test(html), false)
  })
  it("photo absente de la page relue (ou relecture échouée) ⇒ alerte d'état incertain maintenue", () => {
    assert.deepEqual(detailAfterRefresh("pr", [item("p1")]), { fresh: null, confirming: false, stale: true })
    assert.deepEqual(detailAfterRefresh("pr", null), { fresh: null, confirming: false, stale: true })
  })
})

describe("SUPER_ADMIN : formulaire d'ajout seul (la galerie remplace la liste ouvrière)", () => {
  it("showList=false ⇒ formulaire sans liste « Photos du chantier »", () => {
    const html = renderToStaticMarkup(createElement(PhotosEnginsView, {
      context: { role: "SUPER_ADMIN", worksites: [{ id: "w1", name: "Chantier test", clientName: "Client test", status: "IN_PROGRESS" }], trucks: [{ id: "t1", matricule: "ZZ-000-ZZ" }] },
      initialPhotos: [], showList: false,
    }))
    assert.match(html, /Prendre la photo/)
    assert.equal(/Photos du chantier/.test(html), false)
  })
})
