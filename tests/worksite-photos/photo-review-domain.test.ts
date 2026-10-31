/** LOT-ADMIN-REVIEW — domaine pur du contrôle Super Admin : deux dimensions, décisions, filtre, curseur (données synthétiques). */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  WorksitePhotoDomainError, approvalStateOf, canTransitionPhoto, decideApproval, decideDeletion, decideDeletionFinalize, decodeReviewCursor,
  deletionStateOf, deliveryStateOf, encodeReviewCursor, parseReviewFilter, type ReviewFields,
} from "@/lib/worksite-photos/photo.domain"

const T = new Date("2026-10-31T08:00:00.000Z")
const base: ReviewFields = { status: "PENDING", sentAt: null, approvedAt: null, rejectRequestedAt: null, rejectedAt: null, trashRequestedAt: null, trashedAt: null }
const code = (fn: () => unknown) => { try { fn(); return null } catch (e) { return e instanceof WorksitePhotoDomainError ? e.code : String(e) } }

describe("cycle de vie : REJECTED terminal, jamais depuis SENT", () => {
  it("transitions autorisées et interdites", () => {
    assert.equal(canTransitionPhoto("PENDING", "REJECTED"), true)
    assert.equal(canTransitionPhoto("SENT", "REJECTED"), false)
    assert.equal(canTransitionPhoto("REJECTED", "PENDING"), false)
    assert.equal(canTransitionPhoto("REJECTED", "SENT"), false)
    assert.equal(canTransitionPhoto("PENDING", "DELETED"), false)
    assert.equal(canTransitionPhoto("SENT", "DELETED"), true)
  })
})

describe("deux dimensions distinctes : validation interne / envoi au client", () => {
  it("PENDING non validée : à valider, non envoyée", () => {
    assert.equal(approvalStateOf(base), "TO_REVIEW")
    assert.equal(deliveryStateOf(base), "NOT_SENT")
    assert.equal(deletionStateOf(base), "NONE")
  })
  it("validée : toujours non envoyée (la validation n'est pas un envoi)", () => {
    const p = { ...base, approvedAt: T }
    assert.equal(approvalStateOf(p), "APPROVED")
    assert.equal(deliveryStateOf(p), "NOT_SENT")
  })
  it("SENT legacy sans validation : « non tracée », jamais requalifiée validée", () => {
    const p = { ...base, status: "SENT" as const, sentAt: T }
    assert.equal(approvalStateOf(p), "NOT_TRACKED")
    assert.equal(deliveryStateOf(p), "SENT")
  })
  it("DELETED : envoyée (preuve conservée) et en corbeille ; REJECTED : non envoyée et en corbeille", () => {
    assert.equal(deliveryStateOf({ ...base, status: "DELETED", sentAt: T, trashRequestedAt: T, trashedAt: T }), "SENT")
    assert.equal(deletionStateOf({ ...base, status: "DELETED", sentAt: T, trashRequestedAt: T, trashedAt: T }), "TRASHED")
    assert.equal(deliveryStateOf({ ...base, status: "REJECTED", rejectRequestedAt: T, rejectedAt: T }), "NOT_SENT")
    assert.equal(approvalStateOf({ ...base, status: "REJECTED", rejectRequestedAt: T, rejectedAt: T }), "NOT_APPROVED")
    assert.equal(approvalStateOf({ ...base, status: "REJECTED", approvedAt: T, rejectRequestedAt: T, rejectedAt: T }), "APPROVED")
  })
  it("intention posée sans finalisation : « suppression à reprendre » sur les deux chemins", () => {
    assert.equal(deletionStateOf({ ...base, rejectRequestedAt: T }), "TO_RESUME")
    assert.equal(deletionStateOf({ ...base, status: "SENT", sentAt: T, trashRequestedAt: T }), "TO_RESUME")
  })
})

describe("décision de validation", () => {
  it("valide une PENDING ; rejoue une photo déjà validée sans écrire", () => {
    assert.equal(decideApproval(base), "APPROVE")
    assert.equal(decideApproval({ ...base, approvedAt: T }), "REPLAY")
  })
  it("refuse après envoi, après suppression et pendant une suppression", () => {
    assert.equal(code(() => decideApproval({ ...base, status: "SENT", sentAt: T })), "PHOTO_NOT_PENDING")
    assert.equal(code(() => decideApproval({ ...base, status: "REJECTED", rejectRequestedAt: T, rejectedAt: T })), "PHOTO_REMOVED")
    assert.equal(code(() => decideApproval({ ...base, status: "DELETED", sentAt: T, trashRequestedAt: T, trashedAt: T })), "PHOTO_REMOVED")
    assert.equal(code(() => decideApproval({ ...base, rejectRequestedAt: T })), "PHOTO_DELETION_IN_PROGRESS")
  })
})

describe("décision de suppression (deux phases)", () => {
  it("PENDING ⇒ rejet avant envoi ; SENT ⇒ cycle SENT → DELETED ; reprise sans réécrire l'intention", () => {
    assert.deepEqual(decideDeletion(base), { kind: "REJECT", writeIntent: true })
    assert.deepEqual(decideDeletion({ ...base, rejectRequestedAt: T }), { kind: "REJECT", writeIntent: false })
    assert.deepEqual(decideDeletion({ ...base, status: "SENT", sentAt: T }), { kind: "TRASH", writeIntent: true })
    assert.deepEqual(decideDeletion({ ...base, status: "SENT", sentAt: T, trashRequestedAt: T }), { kind: "TRASH", writeIntent: false })
    assert.deepEqual(decideDeletion({ ...base, status: "REJECTED", rejectRequestedAt: T, rejectedAt: T }), { kind: "DONE" })
    assert.deepEqual(decideDeletion({ ...base, status: "DELETED", sentAt: T, trashRequestedAt: T, trashedAt: T }), { kind: "DONE" })
  })
  it("finalisation : une seule fois, selon le chemin ; intention absente ⇒ conflit explicite", () => {
    assert.equal(decideDeletionFinalize({ ...base, rejectRequestedAt: T }), "FINALIZE_REJECT")
    assert.equal(decideDeletionFinalize({ ...base, status: "SENT", sentAt: T, trashRequestedAt: T }), "FINALIZE_TRASH")
    assert.equal(decideDeletionFinalize({ ...base, status: "REJECTED", rejectRequestedAt: T, rejectedAt: T }), "ALREADY_DONE")
    assert.equal(code(() => decideDeletionFinalize(base)), "PHOTO_DELETION_CONFLICT")
  })
})

describe("filtre et curseur de la galerie", () => {
  it("filtre : valeurs fermées, défaut ALL, insensible à la casse", () => {
    assert.equal(parseReviewFilter(null), "ALL")
    assert.equal(parseReviewFilter("to_review"), "TO_REVIEW")
    assert.equal(parseReviewFilter("TO_RESUME"), "TO_RESUME")
    assert.equal(code(() => parseReviewFilter("DROP")), "INVALID_PAYLOAD")
  })
  it("curseur opaque : aller-retour ; forme invalide ⇒ 400", () => {
    const cursor = { uploadedAt: T, id: "photo-1" }
    assert.deepEqual(decodeReviewCursor(encodeReviewCursor(cursor)), cursor)
    assert.equal(decodeReviewCursor(null), null)
    assert.equal(code(() => decodeReviewCursor("pas-un-curseur")), "INVALID_PAYLOAD")
    assert.equal(code(() => decodeReviewCursor(Buffer.from(JSON.stringify({ u: "x", i: "y" })).toString("base64url"))), "INVALID_PAYLOAD")
    assert.equal(code(() => decodeReviewCursor("a".repeat(600))), "INVALID_PAYLOAD")
  })
})
