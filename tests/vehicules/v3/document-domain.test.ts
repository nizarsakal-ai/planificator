// V3 Lot 1 — domaine documentaire pur : fichiers, commandes, statuts, fuseau, rappels.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  assertMetadataForCategory, civilDate, computeDocumentStatus, daysBetween, documentRequestHash, dueReminders, EXPIRED_THRESHOLD,
  parseDocumentArchive, parseDocumentReplace, parseDocumentUpload, parseDocumentVerify, parseReminderSettings, validateDocumentFile, versionStatus,
} from "@/lib/vehicules/v3/document-domain"
import { buildDocumentStorageKey } from "@/lib/vehicules/v3/document-storage.port"
import { JPEG_BYTES, PDF_BYTES, PDF_WITH_JS, PNG_BYTES, key } from "./v3-test-db"

const code = (fn: () => unknown) => { try { fn(); return null } catch (error) { return (error as { code?: string; status?: number }) } }

describe("V3 documents — contrôle du fichier", () => {
  it("accepte PDF, JPEG et PNG dont extension, type déclaré et signature concordent", () => {
    const pdf = validateDocumentFile({ filename: "  ../CT 2026.pdf ", declaredMimeType: "application/pdf; charset=binary", bytes: PDF_BYTES })
    assert.equal(pdf.filename, "CT 2026.pdf")
    assert.equal(pdf.mimeType, "application/pdf")
    assert.equal(pdf.extension, ".pdf")
    assert.match(pdf.sha256, /^[0-9a-f]{64}$/)
    assert.equal(validateDocumentFile({ filename: "photo.JPG", declaredMimeType: "", bytes: JPEG_BYTES }).mimeType, "image/jpeg")
    assert.equal(validateDocumentFile({ filename: "scan.png", declaredMimeType: "application/octet-stream", bytes: PNG_BYTES }).mimeType, "image/png")
  })

  it("refuse vide, trop lourd, type inconnu, extension discordante, déclaration mensongère et PDF actif", () => {
    assert.equal(code(() => validateDocumentFile({ filename: "a.pdf", declaredMimeType: "application/pdf", bytes: new Uint8Array() }))?.code, "DOCUMENT_FILE_EMPTY")
    assert.equal(code(() => validateDocumentFile({ filename: "a.pdf", declaredMimeType: "application/pdf", bytes: PDF_BYTES }, 10))?.status, 413)
    assert.equal(code(() => validateDocumentFile({ filename: "a.docx", declaredMimeType: "application/zip", bytes: new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0, 0]) }))?.code, "DOCUMENT_TYPE_NOT_ALLOWED")
    assert.equal(code(() => validateDocumentFile({ filename: "page.html", declaredMimeType: "text/html", bytes: Buffer.from("<html><script>1</script></html>") }))?.code, "DOCUMENT_TYPE_NOT_ALLOWED")
    assert.equal(code(() => validateDocumentFile({ filename: "a.png", declaredMimeType: "image/png", bytes: PDF_BYTES }))?.code, "DOCUMENT_TYPE_MISMATCH")
    assert.equal(code(() => validateDocumentFile({ filename: "a.pdf", declaredMimeType: "image/png", bytes: PDF_BYTES }))?.code, "DOCUMENT_TYPE_MISMATCH")
    assert.equal(code(() => validateDocumentFile({ filename: "a.pdf", declaredMimeType: "application/pdf", bytes: PDF_WITH_JS }))?.code, "DOCUMENT_ACTIVE_CONTENT")
    assert.equal(code(() => validateDocumentFile({ filename: "/", declaredMimeType: "application/pdf", bytes: PDF_BYTES }))?.code, "DOCUMENT_FILENAME_INVALID")
  })

  it("la clé de stockage est opaque, isolée par entreprise/camion/dossier et refuse les segments douteux", () => {
    const location = { companyId: "c1", truckId: "t1", documentId: "d1", versionId: "v1", sha256: "a".repeat(64), extension: ".pdf" }
    assert.equal(buildDocumentStorageKey(location, { VEHICLE_DOCUMENT_CLOUDINARY_FOLDER_PREFIX: "pf" } as unknown as NodeJS.ProcessEnv), `pf/c1/vehicles/t1/documents/d1/v1-${"a".repeat(16)}.pdf`)
    assert.throws(() => buildDocumentStorageKey({ ...location, truckId: "../x" }, {} as NodeJS.ProcessEnv), /SEGMENT_INVALID/)
    assert.throws(() => buildDocumentStorageKey({ ...location, extension: ".p df" }, {} as NodeJS.ProcessEnv), /EXT_INVALID/)
  })
})

describe("V3 documents — commandes", () => {
  it("ajout : rubrique, intitulé, dates AAAA-MM-JJ, textes bornés, clé UUID obligatoire", () => {
    const parsed = parseDocumentUpload({ category: "INSURANCE", title: " Attestation ", validFrom: "2026-01-01", validUntil: "2026-12-31", issuerName: "Assureur" }, key())
    assert.equal(parsed.title, "Attestation")
    assert.equal(parsed.validUntil, "2026-12-31")
    assert.equal(parsed.mileage, null)
    assert.equal(code(() => parseDocumentUpload({ category: "INSURANCE", title: "x" }, "not-a-uuid"))?.code, "INVALID_IDEMPOTENCY_KEY")
    assert.equal(code(() => parseDocumentUpload({ category: "OTHER", title: "x" }, key()))?.code, "INVALID_PAYLOAD")
    assert.equal(code(() => parseDocumentUpload({ category: "INSURANCE", title: "x", validUntil: "2026-02-30" }, key()))?.code, "INVALID_PAYLOAD")
    assert.equal(code(() => parseDocumentUpload({ category: "INSURANCE", title: "x", validFrom: "2026-12-31", validUntil: "2026-01-01" }, key()))?.code, "DOCUMENT_DATES_INVALID")
    assert.equal(code(() => parseDocumentUpload({ category: "INSURANCE", title: "x", companyId: "other" }, key()))?.code, "INVALID_PAYLOAD")
  })

  it("remplacement, validation, archivage et seuils exigent une révision ; les seuils sont dédoublonnés et triés", () => {
    assert.equal(parseDocumentReplace({ expectedRevision: 2, mileage: 123 }, key()).mileage, 123)
    assert.equal(code(() => parseDocumentReplace({ mileage: 1 }, key()))?.code, "INVALID_PAYLOAD")
    assert.deepEqual(parseDocumentVerify({ expectedRevision: 1, versionId: "v" }), { expectedRevision: 1, versionId: "v" })
    assert.equal(code(() => parseDocumentArchive({ expectedRevision: 1, reason: "  " }))?.code, "INVALID_PAYLOAD")
    assert.deepEqual(parseReminderSettings({ thresholdsDays: [7, 30, 7], expectedRevision: 0 }).thresholdsDays, [30, 7])
    assert.equal(code(() => parseReminderSettings({ thresholdsDays: [], expectedRevision: 0 }))?.code, "INVALID_PAYLOAD")
  })

  it("une facture ancienne sans kilométrage ni intervention est acceptée ; les liens hors rubrique sont refusés", () => {
    assertMetadataForCategory("REPAIR_MAINTENANCE", { validUntil: null, mileage: null, maintenanceEntryId: null })
    assertMetadataForCategory("REPAIR_MAINTENANCE", { validUntil: null, mileage: 50000, maintenanceEntryId: "m" })
    assert.equal(code(() => assertMetadataForCategory("INSURANCE", { validUntil: "2027-01-01", mileage: null, maintenanceEntryId: "m" }))?.code, "DOCUMENT_MAINTENANCE_LINK_INVALID")
    assert.equal(code(() => assertMetadataForCategory("REGISTRATION", { validUntil: "2027-01-01", mileage: null, maintenanceEntryId: null }))?.code, "DOCUMENT_EXPIRY_NOT_APPLICABLE")
  })

  it("l'empreinte dépend du contenu, de la commande et de la portée, pas de la clé", () => {
    const scope = { companyId: "c", truckId: "t", actorId: "u" }
    const file = { sha256: "a".repeat(64), filename: "a.pdf" }
    const base = documentRequestHash("UPLOAD", { category: "INSURANCE", title: "x" }, file, scope)
    assert.equal(base, documentRequestHash("UPLOAD", { title: "x", category: "INSURANCE" }, file, scope))
    assert.notEqual(base, documentRequestHash("UPLOAD", { category: "INSURANCE", title: "x" }, { ...file, sha256: "b".repeat(64) }, scope))
    assert.notEqual(base, documentRequestHash("UPLOAD", { category: "INSURANCE", title: "x" }, file, { ...scope, actorId: "v" }))
    assert.notEqual(base, documentRequestHash("REPLACE", { category: "INSURANCE", title: "x" }, file, { ...scope, documentId: "d" }))
  })
})

describe("V3 documents — dates civiles et statut", () => {
  it("le jour civil suit le fuseau de l'entreprise (23h UTC = lendemain à Paris)", () => {
    const instant = new Date("2026-10-24T23:30:00.000Z")
    assert.equal(civilDate(instant, "Europe/Paris"), "2026-10-25")
    assert.equal(civilDate(instant, "UTC"), "2026-10-24")
    assert.equal(civilDate(instant, "Fuseau/Inconnu"), "2026-10-25")
    assert.equal(daysBetween("2026-10-24", "2026-11-23"), 30)
    assert.equal(daysBetween("2026-10-24", "2026-10-23"), -1)
    assert.equal(daysBetween("2026-02-27", "2026-03-01"), 2)
  })

  it("manquant, à vérifier, valable, bientôt échu, expiré, archivé ; carte grise sans échéance reste valable", () => {
    const today = "2026-10-24"
    const thresholds = [30, 7]
    assert.equal(computeDocumentStatus({ archivedAt: null, currentVersion: null, today, thresholdsDays: thresholds }).status, "MISSING")
    assert.equal(computeDocumentStatus({ archivedAt: null, currentVersion: { verifiedAt: null, validUntil: null }, today, thresholdsDays: thresholds }).status, "TO_VERIFY")
    assert.equal(computeDocumentStatus({ archivedAt: null, currentVersion: { verifiedAt: new Date(), validUntil: null }, today, thresholdsDays: thresholds }).status, "VALID")
    const soon = computeDocumentStatus({ archivedAt: null, currentVersion: { verifiedAt: new Date(), validUntil: new Date("2026-11-20T00:00:00.000Z") }, today, thresholdsDays: thresholds })
    assert.deepEqual([soon.status, soon.remainingDays, soon.validUntil], ["EXPIRING", 27, "2026-11-20"])
    assert.equal(computeDocumentStatus({ archivedAt: null, currentVersion: { verifiedAt: new Date(), validUntil: "2027-06-01" }, today, thresholdsDays: thresholds }).status, "VALID")
    assert.equal(computeDocumentStatus({ archivedAt: null, currentVersion: { verifiedAt: null, validUntil: "2026-10-23" }, today, thresholdsDays: thresholds }).status, "EXPIRED")
    assert.equal(computeDocumentStatus({ archivedAt: null, currentVersion: { verifiedAt: new Date(), validUntil: "2026-10-24" }, today, thresholdsDays: thresholds }).status, "EXPIRING")
    assert.equal(computeDocumentStatus({ archivedAt: new Date(), currentVersion: { verifiedAt: new Date(), validUntil: "2026-10-01" }, today, thresholdsDays: thresholds }).status, "ARCHIVED")
    assert.equal(versionStatus({ verifiedAt: new Date(), validUntil: null, supersededAt: new Date() }, today), "HISTORICAL")
    assert.equal(versionStatus({ verifiedAt: null, validUntil: "2020-01-01", supersededAt: null }, today), "EXPIRED")
  })
})

describe("V3 documents — rappels", () => {
  const base = { documentId: "d", truckId: "t", verifiedAt: null, supersededAt: null, archivedAt: null }
  it("un rappel par seuil atteint, un rappel d'expiration, rien pour une version remplacée ou un dossier archivé", () => {
    const due = dueReminders([
      { ...base, versionId: "far", validUntil: "2027-06-01" },
      { ...base, versionId: "in20", validUntil: "2026-11-13" },
      { ...base, versionId: "in3", validUntil: "2026-10-27" },
      { ...base, versionId: "expired", validUntil: "2026-10-20" },
      { ...base, versionId: "no-date", validUntil: null },
      { ...base, versionId: "replaced", validUntil: "2026-10-25", supersededAt: new Date() },
      { ...base, versionId: "archived", validUntil: "2026-10-25", archivedAt: new Date() },
    ], "2026-10-24", [7, 30])
    assert.deepEqual(due.map((item) => [item.versionId, item.thresholdDays]), [["in20", 30], ["in3", 30], ["in3", 7], ["expired", EXPIRED_THRESHOLD]])
    assert.equal(due[0].remainingDays, 20)
    assert.equal(due[3].dueOn, "2026-10-20")
  })
})
