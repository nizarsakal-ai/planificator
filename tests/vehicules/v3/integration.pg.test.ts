import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { PrismaClient } from "@prisma/client"
import { fixture } from "../pg/fixtures"
import { buildMinimalTextPdf } from "../../../src/lib/acquisition/extraction/pdf-text-extract"
import { extractAddressLines, hashSource } from "../../../src/lib/vehicules/import-domain"
import { reviewImport } from "../../../src/lib/vehicules/import-service"
import { executeMileageCommand, readMileage } from "../../../src/lib/vehicules/mileage-service"
import { uploadVehicleDocument, openVehicleDocumentFile } from "../../../src/lib/vehicules/v3/document-service"
import { buildDocumentStorageKey, type DocumentStoragePort } from "../../../src/lib/vehicules/v3/document-storage.port"
import { executeExpenseCommand } from "../../../src/lib/vehicules/v3/expense-service"
import { readTripCosts, readVehicleCosts } from "../../../src/lib/vehicules/v3/cost-service"
import { createTour, commandTour, readTours } from "../../../src/lib/vehicules/v3/tour-service"
import { consumeVehicleTourImport, validateVehicleExpenseDocument } from "../../../src/lib/vehicules/v3/integration-bridges"

const value = process.env.V3_FINAL_DATABASE_URL
if (!value) throw new Error("V3_FINAL_DATABASE_URL required; no fallback")
const url = new URL(value)
if (url.hostname !== "127.0.0.1" || url.port !== "55433" || url.pathname !== "/v3_final_20261024b" || url.username !== "vehicule_test" || url.search || url.hash)
  throw new Error("Only the dedicated local final V3 database is permitted")
const db = new PrismaClient({ datasources: { db: { url: value } } })

test("V3 cross-lot: private evidence → expense → approved import → atomic tour/V2 → corrected costs", { timeout: 60000 }, async () => {
  const previousFlag = process.env.PLANIFICATOR_VEHICLES_V3_ENABLED
  process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "true"
  try {
    const f = await fixture(db)
    const blobs = new Map<string, Uint8Array>()
    const storage: DocumentStoragePort = {
      provider: "cloudinary",
      async store(location, bytes) { const storageKey = buildDocumentStorageKey(location); blobs.set(storageKey, Uint8Array.from(bytes)); return { storageKey, created: true } },
      async destroy(key) { blobs.delete(key) },
      async createSignedUrl(key) { return `https://storage.example.test/${encodeURIComponent(key)}` },
    }
    const docDeps = { ...f.deps(), storage, fetchSigned: async (signed: string) => {
      const bytes = blobs.get(decodeURIComponent(new URL(signed).pathname.slice(1)))!
      return { ok: true, status: 200, contentLength: bytes.byteLength, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close() } }) }
    } }
    const file = buildMinimalTextPdf("Facture carburant de recette locale uniquement")
    const document = await uploadVehicleDocument(f.truck.id, { category: "EXPENSE_RECEIPT", title: "Ticket carburant test" }, { filename: "ticket.pdf", declaredMimeType: "application/pdf", bytes: file }, randomUUID(), docDeps)
    const opened = await openVehicleDocumentFile(f.truck.id, document.receipt.documentId, document.receipt.versionId, "DOWNLOAD", docDeps)
    assert.equal(Buffer.from(await new Response(opened.stream).arrayBuffer()).equals(file), true)
    const expenseDeps = { ...f.deps(), validateDocumentVersion: validateVehicleExpenseDocument }
    const expenseResult = await executeExpenseCommand(f.truck.id, { action: "CREATE", data: {
      category: "FUEL", occurredAt: new Date().toISOString(), amount: "60.00", currency: "EUR", litres: "30.000", mileageObservation: 1000,
      documentVersionId: document.receipt.versionId,
    } }, randomUUID(), expenseDeps)
    const expense = expenseResult.expense as unknown as { id: string; revision: number }
    assert.equal((await readMileage(f.truck.id, f.deps())).currentMileage, null)
    await assert.rejects(executeExpenseCommand(f.otherTruck.id, { action: "CREATE", data: {
      category: "FUEL", occurredAt: new Date().toISOString(), amount: "60.00", currency: "EUR", documentVersionId: document.receipt.versionId,
    } }, randomUUID(), { ...f.deps(f.session(f.otherCompany.id)), validateDocumentVersion: validateVehicleExpenseDocument }), /DOCUMENT_VERSION_NOT_FOUND/)
    await assert.rejects(db.vehicleExpense.create({ data: { companyId: f.otherCompany.id, truckId: f.otherTruck.id, createdById: f.user.id, category: "FUEL", amount: "1.00", currency: "EUR", occurredAt: new Date(), documentVersionId: document.receipt.versionId } }))
    await executeExpenseCommand(f.truck.id, { action: "APPROVE", expenseId: expense.id, expectedRevision: 1, reason: "Pièce vérifiée en recette" }, randomUUID(), expenseDeps)

    const source = Buffer.from("12 rue Victor Hugo 75001 Paris\n24 avenue Jean Jaures 75019 Paris")
    async function approvedImport() {
      const candidates = extractAddressLines(source.toString()).map(candidate => ({ ...candidate, confirmed: true }))
      const draft = await db.vehicleAddressImport.create({ data: { companyId: f.company.id, truckId: f.truck.id, createdById: f.user.id,
        filename: "tournee.txt", mime: "text/plain", sourceHash: hashSource(source), storageId: randomUUID(), candidates, warnings: [] } })
      await reviewImport(f.truck.id, draft.id, { expectedRevision: 0, approve: true, candidates }, { ...f.deps(), readSource: async () => source })
      return draft.id
    }
    const importId = await approvedImport()
    const tourDeps = { ...f.deps(), consumeApprovedImport: consumeVehicleTourImport }
    const input = { title: "Tournée de recette", startsAt: new Date(Date.now() - 60000).toISOString(), endsAt: new Date(Date.now() + 3600000).toISOString(),
      teamId: null, chauffeurId: null, approvedImportId: importId, approvedImportRevision: 1, stops: [] }
    const key = randomUUID(), tour = await createTour(f.truck.id, input, key, tourDeps)
    assert.equal((await createTour(f.truck.id, input, key, tourDeps)).id, tour.id)
    assert.equal((await db.vehicleAddressImport.findUniqueOrThrow({ where: { id: importId } })).consumptionKey, tour.id)
    await assert.rejects(createTour(f.truck.id, input, randomUUID(), tourDeps), /ALREADY_CONSUMED/)
    const failedImportId = await approvedImport()
    await assert.rejects(createTour(f.truck.id, { ...input, approvedImportId: failedImportId, teamId: "missing-team" }, randomUUID(), tourDeps), /TEAM_NOT_FOUND/)
    assert.equal((await db.vehicleAddressImport.findUniqueOrThrow({ where: { id: failedImportId } })).status, "APPROVED")

    await commandTour(f.truck.id, tour.id, { type: "START", expectedRevision: 1, expectedMileageRevision: 0, mileage: 1000 }, randomUUID(), tourDeps)
    const started = await db.vehicleTour.findUniqueOrThrow({ where: { id: tour.id }, include: { stops: { orderBy: { position: "asc" } } } })
    assert.ok(started.mileageTripId)
    await assert.rejects(executeMileageCommand(f.truck.id, "END", { tripId: started.mileageTripId, mileage: 1250, expectedRevision: 1 }, randomUUID(), f.deps()))
    let revision = 2
    for (const stop of started.stops) {
      await commandTour(f.truck.id, tour.id, { type: "STOP", expectedRevision: revision++, stopId: stop.id }, randomUUID(), tourDeps)
    }
    await commandTour(f.truck.id, tour.id, { type: "COMPLETE", expectedRevision: revision, expectedMileageRevision: 1, mileage: 1250 }, randomUUID(), tourDeps)
    await executeExpenseCommand(f.truck.id, { action: "ALLOCATE", expenseId: expense.id, expectedRevision: 2, reason: "Dépense affectée à la tournée", allocations: [{ mileageTripId: started.mileageTripId, amount: "60.00" }] }, randomUUID(), expenseDeps)
    const trip = await db.mileageTrip.findUniqueOrThrow({ where: { id: started.mileageTripId! } })
    assert.ok(trip.endEntryId)
    await executeMileageCommand(f.truck.id, "CORRECTION", { entryId: trip.endEntryId, expectedEffectiveEntryId: trip.endEntryId, mileage: 1300, expectedRevision: 2, reason: "Correction de recette" }, randomUUID(), f.deps())
    const tours = await readTours(f.truck.id, tourDeps)
    assert.equal(tours.tours.find(item => item.id === tour.id)?.actualKm, 300)
    const tripCosts = await readTripCosts(f.truck.id, trip.id, "EUR", expenseDeps)
    assert.equal(tripCosts.total, "60.00")
    assert.equal(tripCosts.actualKm, 300)
    assert.equal(tripCosts.costPerKm, "0.2000")
    const costs = await readVehicleCosts(f.truck.id, { from: new Date(Date.now() - 86400000).toISOString(), to: new Date(Date.now() + 86400000).toISOString(), currency: "EUR" }, expenseDeps)
    assert.equal(costs.total, "60.00")
    assert.equal(costs.realKm, 300)
    assert.equal(costs.purchasedLitres, "30.000")
  } finally {
    if (previousFlag === undefined) delete process.env.PLANIFICATOR_VEHICLES_V3_ENABLED
    else process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = previousFlag
    await db.$disconnect()
  }
})
