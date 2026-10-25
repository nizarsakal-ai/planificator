// V3 Lot 1 — service documentaire sur double mémoire (aucune connexion PostgreSQL).
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  archiveVehicleDocument, listVehicleDocuments, openVehicleDocumentFile, readReminderSettings, readVehicleDocument, replaceVehicleDocument,
  runVehicleDocumentReminders, updateVehicleDocumentMetadata, updateReminderSettings, uploadVehicleDocument, verifyVehicleDocumentVersion,
} from "@/lib/vehicules/v3/document-service"
import {
  ADMIN, COMPANY, EMPLOYEE, JPEG_BYTES, LEADER, MemoryDocumentStorage, NEXT_LEADER, OTHER_ADMIN, OTHER_TRUCK, PDF_BYTES, SUPER_ADMIN, TRUCK,
  V3MemoryDb, key, pdfFile, sha256Of, streamToBuffer,
} from "./v3-test-db"

const insurance = (over: Record<string, unknown> = {}) => ({ category: "INSURANCE", title: "Attestation 2026", validFrom: "2026-01-01", validUntil: "2026-11-15", issuerName: "Assureur SA", referenceNumber: "CT-42", ...over })
const rejects = async (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => (error as { code?: string }).code === code)

describe("V3 documents — ajout, idempotence et isolation", () => {
  it("un administrateur ajoute une pièce : dossier, version 1, fichier privé, audit ; le replay renvoie le même reçu sans second fichier", async () => {
    const db = new V3MemoryDb()
    const storage = new MemoryDocumentStorage()
    const deps = db.deps(ADMIN, storage)
    const k = key()
    const first = await uploadVehicleDocument(TRUCK, insurance(), pdfFile(), k, deps)
    assert.equal(first.replayed, false)
    assert.equal(first.receipt.versionNumber, 1)
    assert.equal(first.receipt.revision, 1)
    assert.equal(storage.stored.length, 1)
    assert.match(storage.stored[0], new RegExp(`^test/${COMPANY}/vehicles/${TRUCK}/documents/${first.receipt.documentId}/${first.receipt.versionId}-[0-9a-f]{16}\\.pdf$`))
    const version = db.state.vehicleDocumentVersion[0]
    assert.equal(version.storageDeliveryType, "authenticated")
    assert.equal(version.storageResourceType, "raw")
    assert.equal(version.sha256, sha256Of(PDF_BYTES))
    assert.equal(version.verifiedAt, null)
    assert.equal(db.state.vehicleDocument[0].currentVersionId, version.id)
    assert.ok(!("storageUrl" in version) && !("url" in version))
    const audit = db.state.vehicleAuditLog.filter((row) => row.action === "DOCUMENT_UPLOAD")
    assert.equal(audit.length, 1)
    assert.equal(JSON.stringify(db.state.vehicleAuditLog).includes("signature"), false)

    const replay = await uploadVehicleDocument(TRUCK, insurance(), pdfFile(), k, deps)
    assert.equal(replay.replayed, true)
    assert.deepEqual(replay.receipt, first.receipt)
    assert.equal(storage.stored.length, 1)
    assert.equal(db.state.vehicleDocumentVersion.length, 1)
    await rejects(uploadVehicleDocument(TRUCK, insurance({ title: "Autre" }), pdfFile(), k, deps), "IDEMPOTENCY_CONFLICT")
    await rejects(uploadVehicleDocument(TRUCK, insurance(), pdfFile("autre.pdf", JPEG_BYTES), k, deps), "DOCUMENT_TYPE_MISMATCH")
    assert.equal(storage.stored.length, 1)
  })

  it("aucun octet n'est téléversé quand le droit, le camion ou la commande sont refusés", async () => {
    const db = new V3MemoryDb()
    const storage = new MemoryDocumentStorage()
    await rejects(uploadVehicleDocument(TRUCK, insurance(), pdfFile(), key(), db.deps(LEADER, storage)), "FORBIDDEN")
    await rejects(uploadVehicleDocument(TRUCK, insurance(), pdfFile(), key(), db.deps(EMPLOYEE, storage)), "FORBIDDEN")
    await rejects(uploadVehicleDocument(TRUCK, insurance(), pdfFile(), key(), db.deps(OTHER_ADMIN, storage)), "TRUCK_NOT_FOUND")
    await rejects(uploadVehicleDocument(OTHER_TRUCK, insurance(), pdfFile(), key(), db.deps(ADMIN, storage)), "TRUCK_NOT_FOUND")
    await rejects(uploadVehicleDocument(TRUCK, insurance({ category: "REGISTRATION" }), pdfFile(), key(), db.deps(ADMIN, storage)), "DOCUMENT_EXPIRY_NOT_APPLICABLE")
    await rejects(uploadVehicleDocument(TRUCK, { category: "REPAIR_MAINTENANCE", title: "Facture", maintenanceEntryId: "absent" }, pdfFile(), key(), db.deps(ADMIN, storage)), "DOCUMENT_MAINTENANCE_ENTRY_NOT_FOUND")
    await rejects(uploadVehicleDocument(TRUCK, insurance(), pdfFile(), key(), db.deps({ user: { id: "super", role: "SUPER_ADMIN", companyId: null } }, storage)), "NO_COMPANY")
    db.state.companies[0].active = false
    await rejects(uploadVehicleDocument(TRUCK, insurance(), pdfFile(), key(), db.deps(ADMIN, storage)), "FORBIDDEN")
    db.state.companies[0].active = true
    db.state.users[0].active = false
    await rejects(uploadVehicleDocument(TRUCK, insurance(), pdfFile(), key(), db.deps(ADMIN, storage)), "UNAUTHENTICATED")
    db.state.users[0].active = true
    Object.assign(db.state.trucks[0], { active: false, archivedAt: new Date(), teamId: null, chauffeurId: null })
    await rejects(uploadVehicleDocument(TRUCK, insurance(), pdfFile(), key(), db.deps(ADMIN, storage)), "TRUCK_ARCHIVED")
    assert.equal(storage.stored.length, 0)
    assert.equal(db.state.vehicleDocument.length, 0)
  })

  it("une facture ancienne sans kilométrage est conservée ; le lien d'intervention reste facultatif et vérifié dans le tenant", async () => {
    const db = new V3MemoryDb()
    const deps = db.deps()
    const old = await uploadVehicleDocument(TRUCK, { category: "REPAIR_MAINTENANCE", title: "Facture garage 2019", issuedOn: "2019-03-02" }, pdfFile("facture-2019.pdf"), key(), deps)
    const linked = await uploadVehicleDocument(TRUCK, { category: "REPAIR_MAINTENANCE", title: "Vidange", mileage: 118000, maintenanceEntryId: "maint-1" }, pdfFile("vidange.pdf"), key(), deps)
    const versions = db.state.vehicleDocumentVersion
    assert.equal(versions.find((row) => row.id === old.receipt.versionId)?.mileage, null)
    assert.equal(versions.find((row) => row.id === linked.receipt.versionId)?.maintenanceEntryId, "maint-1")
    assert.equal(db.state.trucks[0].currentMileage, 120000, "le compteur V2 n'est jamais touché")
  })

  it("échec du stockage : rien en base ; échec du rattachement : le fichier créé est compensé", async () => {
    const db = new V3MemoryDb()
    const storage = new MemoryDocumentStorage()
    const deps = db.deps(ADMIN, storage)
    storage.failNextStore = true
    await rejects(uploadVehicleDocument(TRUCK, insurance(), pdfFile(), key(), deps), "DOCUMENT_STORAGE_FAILED")
    assert.equal(db.state.vehicleDocumentVersion.length, 0)
    db.failOnce = { operation: "vehicleDocumentVersion.create", error: new Error("sensitive postgresql://db failure") }
    await assert.rejects(uploadVehicleDocument(TRUCK, insurance(), pdfFile(), key(), deps), /sensitive/)
    assert.equal(storage.stored.length, 1)
    assert.deepEqual(storage.destroyed, [storage.stored[0]])
    assert.equal(db.state.vehicleDocument.length, 0)
    assert.equal(db.state.vehicleDocumentVersion.length, 0)
  })
})

describe("V3 documents — lecture, rubriques et droits effectifs", () => {
  async function seeded() {
    const db = new V3MemoryDb()
    const deps = db.deps()
    await uploadVehicleDocument(TRUCK, insurance(), pdfFile("assurance.pdf"), key(), deps)
    await uploadVehicleDocument(TRUCK, { category: "REGISTRATION", title: "Carte grise" }, pdfFile("cg.pdf"), key(), deps)
    await uploadVehicleDocument(TRUCK, { category: "TECHNICAL_INSPECTION", title: "CT 2025", issuedOn: "2025-10-01", validUntil: "2026-10-01" }, pdfFile("ct.pdf"), key(), deps)
    return { db, deps }
  }

  it("statuts calculés dans le fuseau de l'entreprise ; carte grise valable sans échéance une fois validée", async () => {
    const { db, deps } = await seeded()
    const list = await listVehicleDocuments(TRUCK, deps)
    assert.equal(list.today, "2026-10-24")
    assert.equal(list.timezone, "Europe/Paris")
    assert.deepEqual(list.thresholdsDays, [30, 7])
    assert.deepEqual(list.visibleCategories.map((c) => c.code), ["TECHNICAL_INSPECTION", "REPAIR_MAINTENANCE", "REGISTRATION", "INSURANCE", "EXPENSE_RECEIPT"])
    const byTitle = Object.fromEntries(list.documents.map((d) => [d.title, d]))
    assert.equal(byTitle["Attestation 2026"].status, "TO_VERIFY")
    assert.equal(byTitle["CT 2025"].status, "EXPIRED")
    assert.equal(byTitle["CT 2025"].remainingDays, -23)
    assert.equal(byTitle["Carte grise"].status, "TO_VERIFY")
    const cg = byTitle["Carte grise"]
    await verifyVehicleDocumentVersion(TRUCK, cg.id, { expectedRevision: cg.revision, versionId: cg.currentVersion!.id }, deps)
    const ins = byTitle["Attestation 2026"]
    await verifyVehicleDocumentVersion(TRUCK, ins.id, { expectedRevision: ins.revision, versionId: ins.currentVersion!.id }, deps)
    const after = Object.fromEntries((await listVehicleDocuments(TRUCK, deps)).documents.map((d) => [d.title, d]))
    assert.equal(after["Carte grise"].status, "VALID")
    assert.equal(after["Attestation 2026"].status, "EXPIRING")
    assert.equal(after["Attestation 2026"].remainingDays, 22)
    assert.equal(after["Attestation 2026"].revision, 2)
    assert.equal(JSON.stringify(after).includes("storageKey"), false)
    void db
  })

  it("le chef d'équipe affecté voit CT, entretien et assurance, jamais la carte grise ; les autres rôles sont refusés", async () => {
    const { db } = await seeded()
    const leader = await listVehicleDocuments(TRUCK, db.deps(LEADER))
    assert.deepEqual(leader.visibleCategories.map((c) => c.code), ["TECHNICAL_INSPECTION", "REPAIR_MAINTENANCE", "INSURANCE"])
    assert.deepEqual(leader.documents.map((d) => d.category).sort(), ["INSURANCE", "TECHNICAL_INSPECTION"])
    const registration = db.state.vehicleDocument.find((d) => d.category === "REGISTRATION")!
    await rejects(readVehicleDocument(TRUCK, registration.id as string, db.deps(LEADER)), "DOCUMENT_NOT_FOUND")
    await rejects(openVehicleDocumentFile(TRUCK, registration.id as string, registration.currentVersionId as string, "VIEW", db.deps(LEADER)), "DOCUMENT_NOT_FOUND")
    assert.equal(db.state.vehicleAuditLog.filter((row) => row.outcome === "DENIED").length, 1)
    await rejects(listVehicleDocuments(TRUCK, db.deps(NEXT_LEADER)), "TRUCK_NOT_FOUND")
    await rejects(listVehicleDocuments(TRUCK, db.deps(EMPLOYEE)), "FORBIDDEN")
    await rejects(listVehicleDocuments(TRUCK, db.deps({ user: { id: "client", role: "CLIENT", companyId: COMPANY } })), "FORBIDDEN")
    await rejects(listVehicleDocuments(TRUCK, db.deps(OTHER_ADMIN)), "TRUCK_NOT_FOUND")
    assert.equal((await listVehicleDocuments(TRUCK, db.deps(SUPER_ADMIN))).documents.length, 3)
    const insuranceDoc = db.state.vehicleDocument.find((d) => d.category === "INSURANCE")!
    await rejects(verifyVehicleDocumentVersion(TRUCK, insuranceDoc.id as string, { expectedRevision: 1, versionId: insuranceDoc.currentVersionId }, db.deps(LEADER)), "FORBIDDEN")
    await rejects(archiveVehicleDocument(TRUCK, insuranceDoc.id as string, { expectedRevision: 1, reason: "x" }, db.deps(LEADER)), "FORBIDDEN")
    await rejects(replaceVehicleDocument(TRUCK, insuranceDoc.id as string, { expectedRevision: 1 }, pdfFile(), key(), db.deps(LEADER)), "FORBIDDEN")
  })

  it("consultation par proxy : flux du fichier, audit accordé, aucun lien signé dans les données renvoyées ou journalisées", async () => {
    const db = new V3MemoryDb()
    const storage = new MemoryDocumentStorage()
    const deps = db.deps(ADMIN, storage)
    const receipt = (await uploadVehicleDocument(TRUCK, insurance(), pdfFile(), key(), deps)).receipt
    const file = await openVehicleDocumentFile(TRUCK, receipt.documentId, receipt.versionId, "DOWNLOAD", db.deps(LEADER, storage))
    assert.equal(file.filename, "controle-technique.pdf")
    assert.equal(file.mimeType, "application/pdf")
    assert.equal(file.contentLength, PDF_BYTES.byteLength)
    assert.deepEqual([...(await streamToBuffer(file.stream))], [...PDF_BYTES])
    assert.equal(storage.signed.length, 1)
    const granted = db.state.vehicleAuditLog.find((row) => row.action === "DOCUMENT_DOWNLOAD")!
    assert.equal(granted.outcome, "GRANTED")
    assert.equal(granted.actorId, "leader-a")
    assert.equal(JSON.stringify(db.state.vehicleAuditLog).includes("signed.invalid"), false)
    await rejects(openVehicleDocumentFile(TRUCK, receipt.documentId, "missing", "VIEW", deps), "DOCUMENT_NOT_FOUND")
    await rejects(openVehicleDocumentFile(TRUCK, receipt.documentId, receipt.versionId, "VIEW", db.deps(OTHER_ADMIN, storage)), "TRUCK_NOT_FOUND")
    storage.objects.clear()
    await rejects(openVehicleDocumentFile(TRUCK, receipt.documentId, receipt.versionId, "VIEW", deps), "DOCUMENT_FETCH_FAILED")
  })
})

describe("V3 documents — remplacement, validation, archivage", () => {
  it("remplacer crée la version 2, conserve la version 1 en historique, exige la révision et ferme les rappels de l'ancienne version", async () => {
    const db = new V3MemoryDb()
    const storage = new MemoryDocumentStorage()
    const deps = db.deps(ADMIN, storage)
    const v1 = (await uploadVehicleDocument(TRUCK, insurance(), pdfFile("v1.pdf"), key(), deps)).receipt
    db.state.notification.push({ id: "notif-1", userId: "admin-a", companyId: COMPANY, read: false, readAt: null })
    db.state.vehicleDocumentReminder.push({ id: "rem-1", companyId: COMPANY, truckId: TRUCK, documentId: v1.documentId, versionId: v1.versionId, thresholdDays: 30, recipientUserId: "admin-a", notificationId: "notif-1" })
    await rejects(replaceVehicleDocument(TRUCK, v1.documentId, { expectedRevision: 5 }, pdfFile("v2.pdf"), key(), deps), "DOCUMENT_REVISION_CONFLICT")
    assert.equal(storage.stored.length, 1, "aucun téléversement sur conflit de révision")
    const k = key()
    const v2 = (await replaceVehicleDocument(TRUCK, v1.documentId, { expectedRevision: 1, validUntil: "2027-11-15", title: "Attestation 2027" }, pdfFile("v2.pdf"), k, deps)).receipt
    assert.equal(v2.versionNumber, 2)
    assert.equal(v2.revision, 2)
    assert.equal(v2.documentId, v1.documentId)
    const document = db.state.vehicleDocument[0]
    assert.equal(document.currentVersionId, v2.versionId)
    assert.equal(document.title, "Attestation 2027")
    const old = db.state.vehicleDocumentVersion.find((row) => row.id === v1.versionId)!
    assert.ok(old.supersededAt instanceof Date)
    assert.equal(storage.objects.size, 2, "l'ancien fichier n'est jamais détruit")
    assert.equal(db.state.notification[0].read, true)
    const replay = await replaceVehicleDocument(TRUCK, v1.documentId, { expectedRevision: 1, validUntil: "2027-11-15", title: "Attestation 2027" }, pdfFile("v2.pdf"), k, deps)
    assert.equal(replay.replayed, true)
    assert.deepEqual(replay.receipt, v2)
    assert.equal(db.state.vehicleDocumentVersion.length, 2)
    const detail = await readVehicleDocument(TRUCK, v1.documentId, deps)
    assert.deepEqual(detail.versions.map((version) => [version.versionNumber, version.status]), [[2, "TO_VERIFY"], [1, "HISTORICAL"]])
    assert.equal(detail.status, "TO_VERIFY")
  })

  it("deux remplacements concurrents sur la même révision : un seul gagne, l'autre reçoit un conflit sans fichier orphelin rattaché", async () => {
    const db = new V3MemoryDb()
    const storage = new MemoryDocumentStorage()
    const deps = db.deps(ADMIN, storage)
    const v1 = (await uploadVehicleDocument(TRUCK, insurance(), pdfFile("v1.pdf"), key(), deps)).receipt
    const results = await Promise.allSettled([
      replaceVehicleDocument(TRUCK, v1.documentId, { expectedRevision: 1 }, pdfFile("a.pdf"), key(), deps),
      replaceVehicleDocument(TRUCK, v1.documentId, { expectedRevision: 1 }, pdfFile("b.pdf"), key(), deps),
    ])
    assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"])
    assert.equal(((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason as { code: string }).code, "DOCUMENT_REVISION_CONFLICT")
    assert.equal(db.state.vehicleDocumentVersion.length, 2)
    assert.equal(db.state.vehicleDocument[0].revision, 2)
    assert.ok(storage.stored.length <= 3)
    assert.equal(storage.objects.size, 2, "le fichier du perdant a été compensé s'il avait été téléversé")
  })

  it("validation humaine : version courante uniquement, une seule fois, replay toléré ; archivage conserve tout et refuse les écritures suivantes", async () => {
    const db = new V3MemoryDb()
    const deps = db.deps()
    const v1 = (await uploadVehicleDocument(TRUCK, insurance(), pdfFile(), key(), deps)).receipt
    await rejects(verifyVehicleDocumentVersion(TRUCK, v1.documentId, { expectedRevision: 1, versionId: "nope" }, deps), "DOCUMENT_VERSION_NOT_FOUND")
    const verified = await verifyVehicleDocumentVersion(TRUCK, v1.documentId, { expectedRevision: 1, versionId: v1.versionId }, deps)
    assert.deepEqual(verified, { documentId: v1.documentId, versionId: v1.versionId, revision: 2, replayed: false })
    const replay = await verifyVehicleDocumentVersion(TRUCK, v1.documentId, { expectedRevision: 1, versionId: v1.versionId }, deps)
    assert.equal(replay.replayed, true)
    await rejects(verifyVehicleDocumentVersion(TRUCK, v1.documentId, { expectedRevision: 2, versionId: v1.versionId }, deps), "DOCUMENT_ALREADY_VERIFIED")
    const version = db.state.vehicleDocumentVersion[0]
    assert.equal(version.verifiedByNameSnapshot, "Admin A")
    const v2 = (await replaceVehicleDocument(TRUCK, v1.documentId, { expectedRevision: 2 }, pdfFile("v2.pdf"), key(), deps)).receipt
    await rejects(verifyVehicleDocumentVersion(TRUCK, v1.documentId, { expectedRevision: 2, versionId: v1.versionId }, deps), "DOCUMENT_VERSION_NOT_CURRENT")
    await rejects(verifyVehicleDocumentVersion(TRUCK, v1.documentId, { expectedRevision: 3, versionId: v1.versionId }, db.deps({ user: { id: "admin-a2", role: "ADMIN", companyId: COMPANY } })), "DOCUMENT_VERSION_NOT_CURRENT")
    const archived = await archiveVehicleDocument(TRUCK, v1.documentId, { expectedRevision: 3, reason: "Contrat résilié" }, deps)
    assert.deepEqual(archived, { documentId: v1.documentId, revision: 4, replayed: false })
    assert.equal((await archiveVehicleDocument(TRUCK, v1.documentId, { expectedRevision: 3, reason: "Contrat résilié" }, deps)).replayed, true)
    await rejects(archiveVehicleDocument(TRUCK, v1.documentId, { expectedRevision: 3, reason: "Un autre motif" }, deps), "DOCUMENT_ARCHIVED")
    await rejects(verifyVehicleDocumentVersion(TRUCK, v1.documentId, { expectedRevision: 3, versionId: v1.versionId }, deps), "DOCUMENT_ARCHIVED")
    await rejects(replaceVehicleDocument(TRUCK, v1.documentId, { expectedRevision: 4 }, pdfFile("v3.pdf"), key(), deps), "DOCUMENT_ARCHIVED")
    await rejects(verifyVehicleDocumentVersion(TRUCK, v1.documentId, { expectedRevision: 4, versionId: v2.versionId }, deps), "DOCUMENT_ARCHIVED")
    const list = await listVehicleDocuments(TRUCK, deps)
    assert.equal(list.documents[0].status, "ARCHIVED")
    assert.equal(db.state.vehicleDocumentVersion.length, 2)
    const detail = await readVehicleDocument(TRUCK, v1.documentId, deps)
    assert.equal(detail.versions.length, 2)
    assert.equal(detail.archiveReason, "Contrat résilié")
    assert.deepEqual(db.state.vehicleAuditLog.map((row) => row.action), ["DOCUMENT_UPLOAD", "DOCUMENT_VERIFY", "DOCUMENT_REPLACE", "DOCUMENT_ARCHIVE"])
  })

  it("un camion archivé conserve ses pièces consultables ; validation et archivage restent possibles, pas l'ajout", async () => {
    const db = new V3MemoryDb()
    const deps = db.deps()
    const v1 = (await uploadVehicleDocument(TRUCK, insurance(), pdfFile(), key(), deps)).receipt
    Object.assign(db.state.trucks[0], { active: false, archivedAt: new Date(), teamId: null, chauffeurId: null })
    const list = await listVehicleDocuments(TRUCK, deps)
    assert.equal(list.truckActive, false)
    assert.equal(list.documents.length, 1)
    await rejects(replaceVehicleDocument(TRUCK, v1.documentId, { expectedRevision: 1 }, pdfFile(), key(), deps), "TRUCK_ARCHIVED")
    assert.equal((await verifyVehicleDocumentVersion(TRUCK, v1.documentId, { expectedRevision: 1, versionId: v1.versionId }, deps)).revision, 2)
    await rejects(listVehicleDocuments(TRUCK, db.deps(LEADER)), "TRUCK_NOT_FOUND")
  })
})

describe("V3 documents — seuils et rappels internes", () => {
  it("rappels aux administrateurs effectifs et au SUPER_ADMIN contextualisé, sans fallback d'un profil inactif", async () => {
    const db = new V3MemoryDb()
    db.state.users.find(user => user.id === "super")!.companyId = COMPANY
    db.state.employees.push({ id: "inactive-admin-profile", userId: "admin-a2", companyId: COMPANY, active: false, role: "ADMIN" })
    const version = (await uploadVehicleDocument(TRUCK, insurance({ validUntil: "2026-10-30" }), pdfFile("soon.pdf"), key(), db.deps())).receipt
    const summary = await runVehicleDocumentReminders({ db: db as never, clock: () => db.now })
    assert.deepEqual(summary, { companies: 1, created: 4, alreadySent: 0, candidates: 2 })
    const receipts = db.state.vehicleDocumentReminder.filter(row => row.versionId === version.versionId)
    assert.equal(receipts.length, 4)
    assert.deepEqual(new Set(receipts.map(row => row.recipientUserId)), new Set(["admin-a", "super"]))
    assert.ok(receipts.every(row => row.companyId === COMPANY && row.truckId === TRUCK))
    assert.ok(!db.state.notification.some(row => ["admin-a2", "admin-b", "leader-a", "employee"].includes(String(row.userId))))
  })

  it("seuils par entreprise : administrateurs seulement, révision optimiste, replay identique toléré", async () => {
    const db = new V3MemoryDb()
    assert.deepEqual(await readReminderSettings(db.deps()), { thresholdsDays: [30, 7], revision: 0, timezone: "Europe/Paris" })
    await rejects(updateReminderSettings({ thresholdsDays: [15], expectedRevision: 0 }, db.deps(LEADER)), "FORBIDDEN")
    await rejects(updateReminderSettings({ thresholdsDays: [15], expectedRevision: 1 }, db.deps()), "REMINDER_SETTINGS_CONFLICT")
    assert.deepEqual(await updateReminderSettings({ thresholdsDays: [15, 60, 15], expectedRevision: 0 }, db.deps()), { thresholdsDays: [60, 15], revision: 1 })
    assert.deepEqual(await updateReminderSettings({ thresholdsDays: [60, 15], expectedRevision: 0 }, db.deps()), { thresholdsDays: [60, 15], revision: 1 })
    await rejects(updateReminderSettings({ thresholdsDays: [10], expectedRevision: 0 }, db.deps()), "REMINDER_SETTINGS_CONFLICT")
    assert.deepEqual((await listVehicleDocuments(TRUCK, db.deps())).thresholdsDays, [60, 15])
    assert.equal(db.state.vehicleAuditLog.filter((row) => row.action === "REMINDER_SETTINGS_UPDATE").length, 1)
  })

  it("la tâche de rappel notifie chaque administrateur une seule fois par version et seuil, rejoue sans doublon, cesse après remplacement", async () => {
    const db = new V3MemoryDb()
    const deps = db.deps()
    const soon = (await uploadVehicleDocument(TRUCK, insurance({ validUntil: "2026-10-30" }), pdfFile("soon.pdf"), key(), deps)).receipt
    const expired = (await uploadVehicleDocument(TRUCK, { category: "TECHNICAL_INSPECTION", title: "CT", validUntil: "2026-10-01" }, pdfFile("ct.pdf"), key(), deps)).receipt
    await uploadVehicleDocument(TRUCK, { category: "REGISTRATION", title: "CG" }, pdfFile("cg.pdf"), key(), deps)
    const first = await runVehicleDocumentReminders({ db: db as never, clock: () => db.now })
    // soon : 6 jours → seuils 30 et 7 ; expired : seuil -1 ; deux administrateurs (admin-a, admin-a2)
    assert.deepEqual(first, { companies: 1, created: 6, alreadySent: 0, candidates: 3 })
    assert.equal(db.state.notification.length, 6)
    assert.equal(db.state.vehicleDocumentReminder.length, 6)
    const types = db.state.notification.map((row) => row.type)
    assert.equal(types.filter((type) => type === "VEHICLE_DOCUMENT_EXPIRED").length, 2)
    assert.equal(types.filter((type) => type === "VEHICLE_DOCUMENT_EXPIRING").length, 4)
    assert.ok(db.state.notification.every((row) => row.link === `/vehicules/${TRUCK}?onglet=documents`))
    assert.ok(db.state.notification.every((row) => !String(row.message).includes("http")))
    assert.deepEqual(new Set(db.state.notification.map((row) => row.userId)), new Set(["admin-a", "admin-a2"]))

    const second = await runVehicleDocumentReminders({ db: db as never, clock: () => db.now })
    assert.deepEqual(second, { companies: 1, created: 0, alreadySent: 6, candidates: 3 })
    assert.equal(db.state.notification.length, 6)

    const renewed = (await replaceVehicleDocument(TRUCK, soon.documentId, { expectedRevision: 1, validUntil: "2027-10-30" }, pdfFile("renewed.pdf"), key(), deps)).receipt
    assert.equal(db.state.notification.filter((row) => row.read === true).length, 4, "les alertes de l'ancienne version sont fermées")
    await archiveVehicleDocument(TRUCK, expired.documentId, { expectedRevision: 1, reason: "Véhicule contrôlé ailleurs" }, deps)
    const third = await runVehicleDocumentReminders({ db: db as never, clock: () => db.now })
    assert.deepEqual(third, { companies: 1, created: 0, alreadySent: 0, candidates: 0 })
    db.now = new Date("2027-10-25T06:00:00.000Z")
    const fourth = await runVehicleDocumentReminders({ db: db as never, clock: () => db.now })
    // Nouvelle version à cinq jours : deux seuils (30 et 7), chacun pour deux admins.
    assert.deepEqual(fourth, { companies: 1, created: 4, alreadySent: 0, candidates: 2 })
    const renewedReceipts = db.state.vehicleDocumentReminder.filter(row => row.versionId === renewed.versionId)
    assert.equal(renewedReceipts.length, 4)
    assert.deepEqual(new Set(renewedReceipts.map(row => row.thresholdDays)), new Set([30, 7]))
    assert.deepEqual(new Set(renewedReceipts.map(row => row.recipientUserId)), new Set(["admin-a", "admin-a2"]))
    assert.equal(db.state.notification.length, 10)
  })
})

describe("V3 reminders — transaction budget per company",()=>{
 it("plans different companies independently and keeps notifications scoped",async()=>{
  const db=new V3MemoryDb(),storage=new MemoryDocumentStorage()
  await uploadVehicleDocument(TRUCK,insurance(),pdfFile(),key(),db.deps(ADMIN,storage))
  await uploadVehicleDocument(OTHER_TRUCK,insurance(),pdfFile(),key(),db.deps(OTHER_ADMIN,storage))
  const guardedDb={$transaction:async(fn:any,options?:any)=>db.$transaction(async(tx:any)=>{
   const companies=new Set<string>(),find=tx.companySettings.findFirst
   return fn({...tx,companySettings:{...tx.companySettings,findFirst:async(args:any)=>{
    assert.ok(options?.timeout>0&&options.timeout<=30000,"Planning budget must stay bounded");companies.add(args.where.companyId);assert.ok(companies.size<=1,"Multiple companies share the same short planning transaction")
    return find(args)
   }}})
  },options)}
  const result=await runVehicleDocumentReminders({db:guardedDb as never,clock:()=>db.now})
  assert.equal(result.companies,2);assert.ok(result.created>0)
  for(const receipt of db.state.vehicleDocumentReminder){const document=db.state.vehicleDocument.find(d=>d.id===receipt.documentId);assert.equal(receipt.companyId,document?.companyId)}
 })
})


describe("V3 documents — modification explicite sans nouveau fichier",()=>{
 for(const category of ["TECHNICAL_INSPECTION","REPAIR_MAINTENANCE","REGISTRATION","INSURANCE","EXPENSE_RECEIPT"] as const){
  it(`${category} : modifier une pièce vérifiée conserve les anciens champs et octets, crée une version à vérifier et rejoue sans duplication`,async()=>{
   const db=new V3MemoryDb(),storage=new MemoryDocumentStorage(),deps=db.deps(ADMIN,storage);
   const first=(await uploadVehicleDocument(TRUCK,{category,title:"Avant",issuedOn:"2026-01-01",issuerName:"Ancien émetteur",observations:"Avant correction"},pdfFile(),key(),deps)).receipt;
   await verifyVehicleDocumentVersion(TRUCK,first.documentId,{expectedRevision:1,versionId:first.versionId},deps);
   const previous=structuredClone(db.state.vehicleDocumentVersion[0]);
   const command={expectedRevision:2,title:"Après",issuedOn:"2026-02-03",issuerName:"Nouvel émetteur",observations:"Après correction",...(category==="TECHNICAL_INSPECTION"||category==="INSURANCE"?{validUntil:"2027-01-01"}:{})};
   const k=key(),result=await updateVehicleDocumentMetadata(TRUCK,first.documentId,command,k,deps);
   assert.equal(result.replayed,false);assert.equal(result.receipt.versionNumber,2);assert.equal(result.receipt.revision,3);
   const old=db.state.vehicleDocumentVersion.find(v=>v.id===first.versionId)!,current=db.state.vehicleDocumentVersion.find(v=>v.id===result.receipt.versionId)!;
   assert.equal(old.issuedOn instanceof Date?old.issuedOn.toISOString().slice(0,10):old.issuedOn,"2026-01-01");assert.equal(old.issuerName,"Ancien émetteur");assert.equal(old.observations,"Avant correction");assert.deepEqual(old.verifiedAt,previous.verifiedAt);assert.ok(old.supersededAt);
   assert.equal(current.issuerName,"Nouvel émetteur");assert.equal(current.verifiedAt,null);assert.equal(current.verifiedById,null);assert.equal(current.sha256,old.sha256);assert.notEqual(current.storageKey,old.storageKey);
   assert.deepEqual(storage.objects.get(String(current.storageKey)),PDF_BYTES);assert.deepEqual(storage.objects.get(String(old.storageKey)),PDF_BYTES);
   assert.equal(db.state.vehicleDocument[0].title,"Après");assert.equal(db.state.trucks[0].currentMileage,120000);
   const fetched=storage.signed.length,replay=await updateVehicleDocumentMetadata(TRUCK,first.documentId,command,k,deps);
   assert.equal(replay.replayed,true);assert.deepEqual(replay.receipt,result.receipt);assert.equal(storage.stored.length,2);assert.equal(storage.signed.length,fetched);
   await rejects(updateVehicleDocumentMetadata(TRUCK,first.documentId,{...command,title:"Changement divergent"},k,deps),"IDEMPOTENCY_CONFLICT");
   await rejects(updateVehicleDocumentMetadata(TRUCK,first.documentId,command,key(),deps),"DOCUMENT_REVISION_CONFLICT");
  });
 }
 it("droits et tenant refusent la modification avant lecture privée ; intégrité du fichier relue avant publication",async()=>{
  const db=new V3MemoryDb(),storage=new MemoryDocumentStorage(),deps=db.deps(ADMIN,storage);
  const first=(await uploadVehicleDocument(TRUCK,insurance(),pdfFile(),key(),deps)).receipt;
  const body={expectedRevision:1,title:"Corrigé"};
  await rejects(updateVehicleDocumentMetadata(TRUCK,first.documentId,body,key(),db.deps(LEADER,storage)),"FORBIDDEN");
  await rejects(updateVehicleDocumentMetadata(TRUCK,first.documentId,body,key(),db.deps(OTHER_ADMIN,storage)),"TRUCK_NOT_FOUND");
  await rejects(updateVehicleDocumentMetadata(OTHER_TRUCK,first.documentId,body,key(),deps),"TRUCK_NOT_FOUND");
  await rejects(updateVehicleDocumentMetadata(TRUCK,"absent",body,key(),deps),"DOCUMENT_NOT_FOUND");
  assert.equal(storage.signed.length,0);assert.equal(storage.stored.length,1);
  const bytes=new Uint8Array(PDF_BYTES);bytes[0]=0;storage.objects.set(storage.stored[0],bytes);
  await rejects(updateVehicleDocumentMetadata(TRUCK,first.documentId,body,key(),deps),"DOCUMENT_FILE_INTEGRITY");assert.equal(db.state.vehicleDocumentVersion.length,1);assert.equal(storage.stored.length,1);
 });
 it("révocation pendant la lecture privée bloque la publication ; un échec de stockage conserve la version courante",async()=>{
  const db=new V3MemoryDb(),storage=new MemoryDocumentStorage(),deps=db.deps(ADMIN,storage);
  const first=(await uploadVehicleDocument(TRUCK,insurance(),pdfFile(),key(),deps)).receipt;
  const altered={...deps,fetchSigned:async(url:string)=>{const response=await storage.fetchSigned(url);db.state.users[0].active=false;return response}};
  await rejects(updateVehicleDocumentMetadata(TRUCK,first.documentId,{expectedRevision:1,title:"Refus"},key(),altered),"UNAUTHENTICATED");
  assert.equal(storage.stored.length,1);assert.equal(db.state.vehicleDocumentVersion.length,1);db.state.users[0].active=true;
  storage.failNextStore=true;await rejects(updateVehicleDocumentMetadata(TRUCK,first.documentId,{expectedRevision:1,title:"Échec"},key(),deps),"DOCUMENT_STORAGE_FAILED");
  assert.equal(db.state.vehicleDocument[0].currentVersionId,first.versionId);assert.equal(db.state.vehicleDocument[0].revision,1);assert.equal(db.state.vehicleDocumentVersion[0].supersededAt,null);
 });
 it("deux modifications concurrentes ne publient qu’une version ; la copie perdante est compensée",async()=>{
  const db=new V3MemoryDb(),storage=new MemoryDocumentStorage(),deps=db.deps(ADMIN,storage);
  const first=(await uploadVehicleDocument(TRUCK,insurance(),pdfFile(),key(),deps)).receipt;
  const results=await Promise.allSettled([updateVehicleDocumentMetadata(TRUCK,first.documentId,{expectedRevision:1,title:"Correction A"},key(),deps),updateVehicleDocumentMetadata(TRUCK,first.documentId,{expectedRevision:1,title:"Correction B"},key(),deps)]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);assert.equal(db.state.vehicleDocumentVersion.length,2);assert.equal(storage.objects.size,2);assert.equal(db.state.vehicleDocument[0].revision,2);
  assert.equal((results.find(r=>r.status==="rejected") as PromiseRejectedResult).reason.code,"DOCUMENT_REVISION_CONFLICT");
 });
});
