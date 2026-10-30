/**
 * SPEC-WORKSITE-PHOTOS-001 Lot 1 — domaine pur : états, bornes, fichier, nommage, empreinte, preuve, sélections.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { describe, it } from "node:test"
import {
  HARD_PHOTO_MAX_BYTES, DEFAULT_PHOTO_MAX_BYTES, PAGE_MAX_LIMIT,
  WorksitePhotoDomainError, buildDrivePath, canTransitionPhoto, canTransitionReservation, canonicalSentProof,
  civilDayLabel, computeUploadRequestHash, getAbandonQuietHours, getPhotoMaxBytes, getPurgeAfterDays,
  getReservationTtlMinutes, getUnsentAlertDays, isLeaseExpired, isPurgeDue, isRemoteCheckDue, isReservationAborted,
  isReservationPublishable, isTrashReconcileDue, isUnresolvedAbandonAlertDue, isUnsentAlertDue, normalizeDriveLabel,
  parseIdempotencyKey, parseLimit, parseMarkSentBody, parseUploadPayload, photoFileName, sanitizeEventDetail,
  sentProofEquals, validatePhotoFile, worksiteFolderLabel,
} from "@/lib/worksite-photos/photo.domain"
import { isWorksitePhotosAgentEnabled, isWorksitePhotosEnabled } from "@/lib/worksite-photos/feature-flag"
import { testEnv } from "./test-env"

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0, 0, 0])

function code(fn: () => unknown): { code: string; status: number } {
  try { fn() } catch (error) {
    if (error instanceof WorksitePhotoDomainError) return { code: error.code, status: error.status }
    throw error
  }
  throw new Error("expected a WorksitePhotoDomainError")
}

describe("drapeaux", () => {
  it("module et agent désactivés par défaut ; agent exige le module", () => {
    assert.equal(isWorksitePhotosEnabled(testEnv()), false)
    assert.equal(isWorksitePhotosEnabled(testEnv({ PLANIFICATOR_WORKSITE_PHOTOS_ENABLED: "TRUE" })), false)
    assert.equal(isWorksitePhotosEnabled(testEnv({ PLANIFICATOR_WORKSITE_PHOTOS_ENABLED: " true " })), true)
    assert.equal(isWorksitePhotosAgentEnabled(testEnv({ WORKSITE_PHOTOS_AGENT_ENABLED: "true" })), false)
    assert.equal(isWorksitePhotosAgentEnabled(testEnv({ PLANIFICATOR_WORKSITE_PHOTOS_ENABLED: "true", WORKSITE_PHOTOS_AGENT_ENABLED: "true" })), true)
  })
})

describe("transitions", () => {
  it("photo : PENDING→SENT→DELETED seulement", () => {
    assert.ok(canTransitionPhoto("PENDING", "SENT"))
    assert.ok(canTransitionPhoto("SENT", "DELETED"))
    assert.ok(canTransitionPhoto("SENT", "SENT"))
    assert.equal(canTransitionPhoto("PENDING", "DELETED"), false)
    assert.equal(canTransitionPhoto("SENT", "PENDING"), false)
    assert.equal(canTransitionPhoto("DELETED", "SENT"), false)
  })
  it("réservation : aucune publication depuis ABANDONED/CLEANING/CLOSED", () => {
    assert.ok(canTransitionReservation("RESERVED", "UPLOADING"))
    assert.ok(canTransitionReservation("UPLOADING", "COMMITTED"))
    assert.ok(canTransitionReservation("UPLOADING", "ABANDONED"))
    assert.ok(canTransitionReservation("ABANDONED", "CLEANING"))
    assert.ok(canTransitionReservation("CLEANING", "ABANDONED"))
    assert.ok(canTransitionReservation("CLEANING", "CLOSED"))
    assert.equal(canTransitionReservation("ABANDONED", "UPLOADING"), false)
    assert.equal(canTransitionReservation("ABANDONED", "COMMITTED"), false)
    assert.equal(canTransitionReservation("CLEANING", "COMMITTED"), false)
    assert.equal(canTransitionReservation("COMMITTED", "ABANDONED"), false)
    assert.equal(canTransitionReservation("CLOSED", "ABANDONED"), false)
    for (const state of ["ABANDONED", "CLEANING", "CLOSED"] as const) {
      assert.equal(isReservationAborted(state), true)
      assert.equal(isReservationPublishable(state), false)
    }
    assert.equal(isReservationPublishable("RESERVED"), true)
    assert.equal(isReservationPublishable("COMMITTED"), false)
  })
})

describe("bornes de configuration", () => {
  it("taille : défaut 3 Mio, plafond dur 4 Mio, valeurs invalides ignorées", () => {
    assert.equal(getPhotoMaxBytes(testEnv()), DEFAULT_PHOTO_MAX_BYTES)
    assert.equal(getPhotoMaxBytes(testEnv({ WORKSITE_PHOTOS_MAX_BYTES: String(10 * 1024 * 1024) })), HARD_PHOTO_MAX_BYTES)
    assert.equal(getPhotoMaxBytes(testEnv({ WORKSITE_PHOTOS_MAX_BYTES: "1048576" })), 1048576)
    assert.equal(getPhotoMaxBytes(testEnv({ WORKSITE_PHOTOS_MAX_BYTES: "abc" })), DEFAULT_PHOTO_MAX_BYTES)
    assert.equal(getPhotoMaxBytes(testEnv({ WORKSITE_PHOTOS_MAX_BYTES: "0" })), DEFAULT_PHOTO_MAX_BYTES)
  })
  it("bail [5,60], calme [1,72], alerte [1,365], purge [1,30]", () => {
    assert.equal(getReservationTtlMinutes(testEnv()), 15)
    assert.equal(getReservationTtlMinutes(testEnv({ WORKSITE_PHOTOS_RESERVATION_TTL_MINUTES: "2" })), 15)
    assert.equal(getReservationTtlMinutes(testEnv({ WORKSITE_PHOTOS_RESERVATION_TTL_MINUTES: "600" })), 60)
    assert.equal(getAbandonQuietHours(testEnv()), 24)
    assert.equal(getAbandonQuietHours(testEnv({ WORKSITE_PHOTOS_ABANDON_QUIET_HOURS: "100" })), 72)
    assert.equal(getUnsentAlertDays(testEnv()), 7)
    assert.equal(getPurgeAfterDays(testEnv()), 30)
    assert.equal(getPurgeAfterDays(testEnv({ WORKSITE_PHOTOS_PURGE_AFTER_DAYS: "45" })), 30)
  })
})

describe("validation de fichier", () => {
  it("JPEG et PNG acceptés avec extension et type cohérents ; SHA-256 calculé", () => {
    const jpeg = validatePhotoFile({ filename: "IMG_1.JPG", declaredMimeType: "image/jpeg", bytes: JPEG })
    assert.equal(jpeg.mimeType, "image/jpeg")
    assert.equal(jpeg.extension, ".jpg")
    assert.equal(jpeg.sha256, createHash("sha256").update(JPEG).digest("hex"))
    const png = validatePhotoFile({ filename: "photo.png", declaredMimeType: "application/octet-stream", bytes: PNG })
    assert.equal(png.mimeType, "image/png")
  })
  it("refus : vide, trop grand, PDF, renommé, type déclaré incohérent, nom invalide, checksum", () => {
    assert.deepEqual(code(() => validatePhotoFile({ filename: "a.jpg", declaredMimeType: "", bytes: new Uint8Array() })), { code: "PHOTO_FILE_EMPTY", status: 400 })
    assert.deepEqual(code(() => validatePhotoFile({ filename: "a.jpg", declaredMimeType: "", bytes: JPEG }, 4)), { code: "PHOTO_FILE_TOO_LARGE", status: 413 })
    assert.deepEqual(code(() => validatePhotoFile({ filename: "a.pdf", declaredMimeType: "application/pdf", bytes: PDF })), { code: "PHOTO_TYPE_NOT_ALLOWED", status: 415 })
    assert.deepEqual(code(() => validatePhotoFile({ filename: "a.png", declaredMimeType: "", bytes: JPEG })), { code: "PHOTO_TYPE_MISMATCH", status: 415 })
    assert.deepEqual(code(() => validatePhotoFile({ filename: "a.jpg", declaredMimeType: "image/png", bytes: JPEG })), { code: "PHOTO_TYPE_MISMATCH", status: 415 })
    assert.deepEqual(code(() => validatePhotoFile({ filename: "../../", declaredMimeType: "", bytes: JPEG })), { code: "PHOTO_FILENAME_INVALID", status: 400 })
    assert.deepEqual(code(() => validatePhotoFile({ filename: "a.jpg", declaredMimeType: "", bytes: JPEG, clientSha256: "0".repeat(64) })), { code: "PHOTO_CHECKSUM_MISMATCH", status: 400 })
    assert.deepEqual(code(() => validatePhotoFile({ filename: "a.jpg", declaredMimeType: "", bytes: JPEG, clientSha256: "pas-un-hash" })), { code: "INVALID_PAYLOAD", status: 400 })
    assert.equal(validatePhotoFile({ filename: "a.jpg", declaredMimeType: "", bytes: JPEG, clientSha256: createHash("sha256").update(JPEG).digest("hex").toUpperCase() }).sha256.length, 64)
  })
  it("le plafond dur s'applique même si l'appelant passe plus", () => {
    const big = new Uint8Array(HARD_PHOTO_MAX_BYTES + 1)
    big.set(JPEG)
    assert.deepEqual(code(() => validatePhotoFile({ filename: "a.jpg", declaredMimeType: "", bytes: big }, 100 * 1024 * 1024)), { code: "PHOTO_FILE_TOO_LARGE", status: 413 })
  })
})

describe("nommage Drive", () => {
  it("libellés nettoyés, bornés, jamais vides", () => {
    assert.equal(normalizeDriveLabel('  Lauralu / SAS : "Nord"  *?  '), "Lauralu SAS Nord")
    assert.equal(normalizeDriveLabel("\u0000\u0001"), "sans-nom")
    assert.equal(normalizeDriveLabel("x".repeat(200)).length, 80)
  })
  it("dossier chantier : client-chantier~id6, borné 80", () => {
    const label = worksiteFolderLabel("Lauralu SAS", "Rénovation hall / expo", "cmh7x9abc123")
    assert.equal(label, "Lauralu SAS-Rénovation hall expo~cmh7x9")
    assert.ok(worksiteFolderLabel("a".repeat(100), "b".repeat(100), "id123456").length <= 80)
    assert.ok(worksiteFolderLabel("a".repeat(100), "b".repeat(100), "id123456").endsWith("~id1234"))
  })
  it("jour civil dans le fuseau et nom de fichier", () => {
    const instant = new Date("2026-10-30T23:30:00.000Z") // 00:30 le 31 à Paris (UTC+1)
    assert.equal(civilDayLabel(instant, "Europe/Paris"), "2026-10-31")
    assert.equal(civilDayLabel(instant, "UTC"), "2026-10-30")
    const name = photoFileName({ instant, timeZone: "Europe/Paris", matricule: "ab-123 cd", phase: "BEFORE", photoId: "cmh7x9abcDEF", extension: ".jpg" })
    assert.equal(name, "20261031-003000_AB-123CD_AVANT_cmh7x9ab.jpg")
    assert.equal(buildDrivePath("Lauralu-Chantier~cmh7x9", "2026-10-31", name), `/Chantiers/Lauralu-Chantier~cmh7x9/2026-10-31/${name}`)
  })
})

describe("empreinte de requête", () => {
  const base = { companyId: "c1", actorId: "u1", worksiteId: "w1", truckId: "t1", phase: "BEFORE" as const, sha256: "a".repeat(64), sizeBytes: 10 }
  it("stable, hexadécimale, sensible au tenant, à l'acteur, à l'engin et au contenu", () => {
    const h = computeUploadRequestHash(base)
    assert.match(h, /^[0-9a-f]{64}$/)
    assert.equal(computeUploadRequestHash({ ...base }), h)
    assert.notEqual(computeUploadRequestHash({ ...base, companyId: "c2" }), h)
    assert.notEqual(computeUploadRequestHash({ ...base, actorId: "u2" }), h)
    assert.notEqual(computeUploadRequestHash({ ...base, truckId: "t2" }), h)
    assert.notEqual(computeUploadRequestHash({ ...base, sha256: "b".repeat(64) }), h)
    assert.notEqual(computeUploadRequestHash({ ...base, phase: "AFTER" }), h)
  })
})

describe("schémas", () => {
  const route = { worksiteId: "w1", truckId: "t1" }
  it("payload upload strict ; identifiants répétés cohérents ou 400 PAYLOAD_MISMATCH", () => {
    assert.deepEqual(parseUploadPayload({ phase: "AFTER" }, route), { phase: "AFTER" })
    assert.equal(parseUploadPayload({ phase: "AFTER", worksiteId: "w1", truckId: "t1" }, route).phase, "AFTER")
    assert.deepEqual(code(() => parseUploadPayload({ phase: "AFTER", worksiteId: "w2" }, route)), { code: "PAYLOAD_MISMATCH", status: 400 })
    assert.deepEqual(code(() => parseUploadPayload({ phase: "AFTER", truckId: "t9" }, route)), { code: "PAYLOAD_MISMATCH", status: 400 })
    assert.deepEqual(code(() => parseUploadPayload({ phase: "MIDDLE" }, route)), { code: "INVALID_PAYLOAD", status: 400 })
    assert.deepEqual(code(() => parseUploadPayload({ phase: "AFTER", extra: 1 }, route)), { code: "INVALID_PAYLOAD", status: 400 })
    assert.deepEqual(code(() => parseUploadPayload({ phase: "AFTER", clientSha256: "zz" }, route)), { code: "INVALID_PAYLOAD", status: 400 })
  })
  it("Idempotency-Key : UUID obligatoire", () => {
    assert.equal(parseIdempotencyKey(" 11111111-1111-4111-8111-111111111111 "), "11111111-1111-4111-8111-111111111111")
    assert.deepEqual(code(() => parseIdempotencyKey(null)), { code: "IDEMPOTENCY_KEY_REQUIRED", status: 400 })
    assert.deepEqual(code(() => parseIdempotencyKey("abc")), { code: "IDEMPOTENCY_KEY_REQUIRED", status: 400 })
  })
  it("mark-sent : preuve complète obligatoire, transportKind borné, corps strict", () => {
    const ok = parseMarkSentBody({ sentTo: " Client@Lauralu.fr ", sentMessageId: "<abc@mail>", transportKind: "provider:resend", transportRef: "re_1" })
    assert.equal(ok.sentTo, "Client@Lauralu.fr")
    assert.deepEqual(code(() => parseMarkSentBody({ sentTo: "a@b.fr", sentMessageId: "<x>" })), { code: "SENT_PROOF_REQUIRED", status: 400 })
    assert.deepEqual(code(() => parseMarkSentBody({ sentTo: "a@b.fr", sentMessageId: "<x>", transportKind: "pigeon" })), { code: "SENT_PROOF_REQUIRED", status: 400 })
    assert.deepEqual(code(() => parseMarkSentBody({ sentTo: "pas-un-email", sentMessageId: "<x>", transportKind: "smtp" })), { code: "SENT_PROOF_REQUIRED", status: 400 })
    assert.deepEqual(code(() => parseMarkSentBody({ sentTo: "a@b.fr", sentMessageId: "  ", transportKind: "smtp" })), { code: "SENT_PROOF_REQUIRED", status: 400 })
    assert.deepEqual(code(() => parseMarkSentBody({ sentTo: "a@b.fr", sentMessageId: "<x>", transportKind: "smtp", inconnu: 1 })), { code: "SENT_PROOF_REQUIRED", status: 400 })
  })
  it("preuve canonique : casse et espaces du destinataire ignorés, transport comparé, sentAt/transportRef ignorés", () => {
    const a = { sentTo: "Client@Lauralu.fr", sentMessageId: "<abc@mail>", transportKind: "smtp" }
    assert.ok(sentProofEquals(a, { sentTo: " client@lauralu.fr ", sentMessageId: "<abc@mail>", transportKind: "smtp" }))
    assert.equal(sentProofEquals(a, { ...a, sentTo: "autre@lauralu.fr" }), false)
    assert.equal(sentProofEquals(a, { ...a, transportKind: "provider:resend" }), false)
    assert.equal(sentProofEquals(a, { ...a, sentMessageId: "<autre>" }), false)
    assert.equal(canonicalSentProof(a), JSON.stringify(["client@lauralu.fr", "<abc@mail>", "smtp"]))
  })
  it("pagination bornée à 100", () => {
    assert.equal(parseLimit(null), 50)
    assert.equal(parseLimit("1000"), PAGE_MAX_LIMIT)
    assert.deepEqual(code(() => parseLimit("0")), { code: "INVALID_PAYLOAD", status: 400 })
    assert.deepEqual(code(() => parseLimit("x")), { code: "INVALID_PAYLOAD", status: 400 })
  })
})

describe("sélections des tâches planifiées", () => {
  const now = new Date("2026-11-07T00:00:00.000Z")
  it("alerte J+7 : bornes exactes, jamais deux fois, PENDING seulement", () => {
    assert.equal(isUnsentAlertDue({ status: "PENDING", uploadedAt: new Date("2026-10-31T00:00:00.000Z"), unsentAlertedAt: null }, now, 7), true)
    assert.equal(isUnsentAlertDue({ status: "PENDING", uploadedAt: new Date("2026-10-31T00:00:01.000Z"), unsentAlertedAt: null }, now, 7), false)
    assert.equal(isUnsentAlertDue({ status: "PENDING", uploadedAt: new Date("2026-10-01T00:00:00.000Z"), unsentAlertedAt: now }, now, 7), false)
    assert.equal(isUnsentAlertDue({ status: "SENT", uploadedAt: new Date("2026-10-01T00:00:00.000Z"), unsentAlertedAt: null }, now, 7), false)
  })
  it("purge à 30 jours de la corbeille, DELETED non purgée seulement", () => {
    assert.equal(isPurgeDue({ status: "DELETED", trashedAt: new Date("2026-10-08T00:00:00.000Z"), purgedAt: null }, now, 30), true)
    assert.equal(isPurgeDue({ status: "DELETED", trashedAt: new Date("2026-10-09T00:00:00.000Z"), purgedAt: null }, now, 30), false)
    assert.equal(isPurgeDue({ status: "DELETED", trashedAt: new Date("2026-10-01T00:00:00.000Z"), purgedAt: now }, now, 30), false)
    assert.equal(isPurgeDue({ status: "SENT", trashedAt: null, purgedAt: null }, now, 30), false)
  })
  it("bail et reprise de suppression", () => {
    assert.equal(isLeaseExpired(new Date(now.getTime() - 1), now), true)
    assert.equal(isLeaseExpired(new Date(now.getTime() + 1), now), false)
    assert.equal(isTrashReconcileDue({ status: "SENT", trashRequestedAt: new Date(now.getTime() - 11 * 60_000), trashedAt: null }, now), true)
    assert.equal(isTrashReconcileDue({ status: "SENT", trashRequestedAt: new Date(now.getTime() - 60_000), trashedAt: null }, now), false)
    assert.equal(isTrashReconcileDue({ status: "DELETED", trashRequestedAt: new Date(now.getTime() - 11 * 60_000), trashedAt: now }, now), false)
  })
  it("surveillance durable : horaire pendant la période de calme, puis quotidienne sans fin ; alerte unique", () => {
    const abandonedAt = new Date(now.getTime() - 2 * 3_600_000)
    assert.equal(isRemoteCheckDue({ state: "ABANDONED", abandonedAt, lastRemoteCheckAt: null }, now, 24), true)
    assert.equal(isRemoteCheckDue({ state: "ABANDONED", abandonedAt, lastRemoteCheckAt: new Date(now.getTime() - 30 * 60_000) }, now, 24), false)
    assert.equal(isRemoteCheckDue({ state: "ABANDONED", abandonedAt, lastRemoteCheckAt: new Date(now.getTime() - 61 * 60_000) }, now, 24), true)
    const old = new Date(now.getTime() - 40 * 24 * 3_600_000) // bien au-delà de la période de calme : toujours surveillée
    assert.equal(isRemoteCheckDue({ state: "ABANDONED", abandonedAt: old, lastRemoteCheckAt: new Date(now.getTime() - 2 * 3_600_000) }, now, 24), false)
    assert.equal(isRemoteCheckDue({ state: "ABANDONED", abandonedAt: old, lastRemoteCheckAt: new Date(now.getTime() - 25 * 3_600_000) }, now, 24), true)
    assert.equal(isRemoteCheckDue({ state: "CLOSED", abandonedAt: old, lastRemoteCheckAt: null }, now, 24), false)
    // Date d'abandon inconnue : côté sûr, cadence horaire conservée
    assert.equal(isRemoteCheckDue({ state: "ABANDONED", abandonedAt: null, lastRemoteCheckAt: new Date(now.getTime() - 61 * 60_000) }, now, 24), true)
    assert.equal(isRemoteCheckDue({ state: "ABANDONED", abandonedAt: null, lastRemoteCheckAt: new Date(now.getTime() - 30 * 60_000) }, now, 24), false)
    assert.equal(isUnresolvedAbandonAlertDue({ state: "ABANDONED", abandonedAt, lastRemoteCheckAt: null, unresolvedAlertedAt: null }, now, 24), false)
    assert.equal(isUnresolvedAbandonAlertDue({ state: "ABANDONED", abandonedAt: old, lastRemoteCheckAt: null, unresolvedAlertedAt: null }, now, 24), true)
    assert.equal(isUnresolvedAbandonAlertDue({ state: "ABANDONED", abandonedAt: old, lastRemoteCheckAt: null, unresolvedAlertedAt: now }, now, 24), false)
  })
})

describe("journal : aucune URL, aucun secret, e-mails hachés", () => {
  it("filtre les valeurs interdites et hache les adresses", () => {
    const out = sanitizeEventDetail({ url: "https://drive.google.com/x", token: "token=abc", to: "Client@Lauralu.fr", count: 3, ok: true, none: null })
    assert.equal("url" in out, false)
    assert.equal("token" in out, false)
    assert.match(String(out.to), /^sha256:[0-9a-f]{16}$/)
    assert.equal(out.count, 3)
    assert.equal(out.ok, true)
    assert.equal(out.none, null)
  })
})
