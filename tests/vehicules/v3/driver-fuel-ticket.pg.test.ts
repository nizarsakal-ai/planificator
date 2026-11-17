/**
 * Ticket du chauffeur sur PostgreSQL réel (base jetable locale migrée) : droits, justificatif privé,
 * complément du plein bancaire, création, rejeu idempotent, refus d'un non-chauffeur.
 *   DRIVER_TICKET_DATABASE_URL=postgresql://test:test@127.0.0.1:5432/driver_ticket_test
 */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { PrismaClient } from "@prisma/client"
import { fixture } from "../pg/fixtures"
import { buildDocumentStorageKey, type DocumentStoragePort } from "../../../src/lib/vehicules/v3/document-storage.port"
import { executeExpenseCommand } from "../../../src/lib/vehicules/v3/expense-service"
import { bankFuelExpenseCommand, bankLineIdempotencyKey } from "../../../src/lib/vehicules/v3/bank-fuel-domain"
import { readMyTrucks, submitDriverTicket } from "../../../src/lib/vehicules/v3/driver-fuel-ticket-service"

const value = process.env.DRIVER_TICKET_DATABASE_URL
if (!value) throw new Error("DRIVER_TICKET_DATABASE_URL requis (base PostgreSQL locale jetable migrée)")
const url = new URL(value)
if (!["127.0.0.1", "localhost"].includes(url.hostname) || !/test/.test(url.pathname)) throw new Error("Base locale de test uniquement")
const db = new PrismaClient({ datasources: { db: { url: value } } })

// Plus petit JPEG valide (octets magiques contrôlés par le service).
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9])
const file = (n = 0) => ({ filename: "ticket.jpg", declaredMimeType: "image/jpeg", bytes: Uint8Array.from([...JPEG.slice(0, -2), n, 0xff, 0xd9]) })

test("ticket du chauffeur : complète le plein bancaire, sinon crée ; refus hors de son camion", { timeout: 60000 }, async () => {
  const previous = process.env.PLANIFICATOR_VEHICLES_V3_ENABLED
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
    const mk = async (name: string) => {
      const user = await db.user.create({ data: { email: `${randomUUID()}@example.test`, password: "unused", role: "EMPLOYEE", companyId: f.company.id, name } })
      const employee = await db.employee.create({ data: { userId: user.id, companyId: f.company.id, role: "EMPLOYEE", firstName: name, lastName: "Test" } })
      return { user, employee, deps: { auth: async () => ({ user: { id: user.id, role: "EMPLOYEE", companyId: f.company.id } }), db, storage } }
    }
    const hassen = await mk("Hassen")
    const bilel = await mk("Bilel")
    await db.truck.update({ where: { id: f.truck.id }, data: { chauffeurId: hassen.employee.id } })

    assert.deepEqual((await readMyTrucks(hassen.deps)).trucks.map((t) => t.id), [f.truck.id])
    assert.deepEqual((await readMyTrucks(bilel.deps)).trucks, [])

    // Plein importé du relevé (administrateur), sans litres ni ticket.
    const line = { id: `tx-${randomUUID()}`, day: "2026-11-05", label: "CARTE X1111 TOTAL CARCASSONNE", amount: "95.50", card: "1111" }
    const created = await executeExpenseCommand(f.truck.id, bankFuelExpenseCommand(line), bankLineIdempotencyKey("ab".repeat(32)), f.deps())
    const bankId = (created.expense as { id: string }).id

    // 1. Ticket du même plein (lendemain, même montant) : complète le plein bancaire.
    const key = randomUUID()
    const r1 = await submitDriverTicket({ truckId: f.truck.id, amount: "95,50", litres: "52,3", day: "2026-11-06", station: "TotalEnergies Carcassonne" }, file(1), key, hassen.deps)
    assert.equal(r1.outcome, "COMPLETED_BANK_EXPENSE")
    const completed = await db.vehicleExpense.findUniqueOrThrow({ where: { id: bankId } })
    assert.equal(completed.litres?.toString(), "52.3")
    assert.equal(completed.reference, line.id.replace(/^/, "BANQUE:"))
    assert.equal(completed.supplier, line.label)
    assert.ok(completed.documentVersionId)
    const version = await db.vehicleDocumentVersion.findUniqueOrThrow({ where: { id: completed.documentVersionId! }, include: { document: true } })
    assert.equal(version.document.category, "EXPENSE_RECEIPT")
    assert.equal(version.uploadedById, hassen.user.id)
    assert.equal(blobs.size, 1)

    // 2. Rejeu (connexion perdue) : rien de nouveau.
    const replay = await submitDriverTicket({ truckId: f.truck.id, amount: "95,50", litres: "52,3", day: "2026-11-06", station: "TotalEnergies Carcassonne" }, file(1), key, hassen.deps)
    assert.equal(replay.replayed, true)
    assert.equal(await db.vehicleDocument.count({ where: { truckId: f.truck.id } }), 1)

    // 3. Ticket sans plein bancaire : nouveau plein « à valider » avec son justificatif.
    const r3 = await submitDriverTicket({ truckId: f.truck.id, amount: "61", litres: "34", day: "2026-11-10", station: null }, file(2), randomUUID(), hassen.deps)
    assert.equal(r3.outcome, "CREATED")
    const fresh = await db.vehicleExpense.findUniqueOrThrow({ where: { id: r3.expenseId } })
    assert.deepEqual([fresh.category, fresh.status, fresh.amount.toString(), fresh.litres?.toString(), fresh.createdById], ["FUEL", "PENDING", "61", "34", hassen.user.id])
    assert.ok(fresh.documentVersionId)

    // 4. Non-chauffeur de ce camion, et camion d'une autre société : refus, aucun fichier stocké.
    const before = blobs.size
    await assert.rejects(submitDriverTicket({ truckId: f.truck.id, amount: "10", day: "2026-11-10" }, file(3), randomUUID(), bilel.deps), /TRUCK_NOT_FOUND/)
    await assert.rejects(submitDriverTicket({ truckId: f.otherTruck.id, amount: "10", day: "2026-11-10" }, file(4), randomUUID(), hassen.deps), /TRUCK_NOT_FOUND/)
    // Date future refusée.
    await assert.rejects(submitDriverTicket({ truckId: f.truck.id, amount: "10", day: "2099-01-01" }, file(5), randomUUID(), hassen.deps), /TICKET_DATE_INVALID/)
    assert.equal(blobs.size, before)

    // 5. Chauffeur retiré du camion : plus aucun droit.
    await db.truck.update({ where: { id: f.truck.id }, data: { chauffeurId: null } })
    await assert.rejects(submitDriverTicket({ truckId: f.truck.id, amount: "10", day: "2026-11-10" }, file(6), randomUUID(), hassen.deps), /TRUCK_NOT_FOUND/)

    // Audit : le dépôt et la commande de dépense sont tracés au nom du chauffeur.
    const commands = await db.vehicleExpenseCommand.findMany({ where: { truckId: f.truck.id, actorId: hassen.user.id } })
    assert.deepEqual(commands.map((c) => c.action).sort(), ["CORRECT", "CREATE"])
  } finally {
    process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = previous
    await db.$disconnect()
  }
})
