import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { PrismaClient } from "@prisma/client"
import { fixture } from "./pg/fixtures"
import { executeExpenseCommand, readExpenses } from "../../src/lib/vehicules/v3/expense-service"
import { readVehicleCosts } from "../../src/lib/vehicules/v3/cost-service"
import { executeMileageCommand, readMileage } from "../../src/lib/vehicules/mileage-service"
const value = process.env.V3_COSTS_DATABASE_URL
if (!value) throw new Error("V3_COSTS_DATABASE_URL required; no fallback")
const url = new URL(value)
if (url.hostname !== "127.0.0.1" || url.port !== "55433" || url.pathname !== "/v3_costs_test" || url.username !== "vehicule_test" || url.search || url.hash) throw new Error("Refusing non-disposable costs DB")
const db = new PrismaClient({ datasources: { db: { url: value } } })
process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "true"
test("PostgreSQL costs: exact amounts, atomic audit, concurrency, sources, roles, corrected trip coverage", { timeout: 50000 }, async () => {
 try {
  const f = await fixture(db)
  const run = async (body: unknown, key = randomUUID(), deps = f.deps(), truckId = f.truck.id) => {
    const result = await executeExpenseCommand(truckId, body, key, deps)
    return { ...result, expense: result.expense as unknown as { id: string; revision: number; status: string; amount: string } }
  }
  const data = { category: "FUEL", occurredAt: "2020-01-15T00:00:00Z", amount: "30.00", currency: "EUR", litres: "15.000", mileageObservation: 500 }
  await assert.rejects(run({ action: "CREATE", data: { ...data, documentVersionId: "untrusted" } }), /DOCUMENT_VERSION_NOT_FOUND/)
  await assert.rejects(run({ action: "CREATE", data: { ...data, maintenanceEntryId: "foreign" } }), /MAINTENANCE_ENTRY_NOT_FOUND/)
  const key = randomUUID(), payload = { action: "CREATE", data }
  const replays = await Promise.all([run(payload, key), run(payload, key)])
  assert.equal(replays[0].expense.id, replays[1].expense.id)
  assert.deepEqual(replays.map(r => r.replayed).sort(), [false, true])
  let expense = replays[0].expense
  assert.equal(expense.amount, "30.00")
  await assert.rejects(db.$executeRaw`UPDATE "vehicle_expenses" SET "amount" = 'NaN'::numeric WHERE "id" = ${expense.id}`)

  assert.equal((await readMileage(f.truck.id, f.deps())).currentMileage, null) // observation jamais écrite en V2
  await assert.rejects(run({ action: "CREATE", data: { ...data, amount: "31.00" } }, key), /IDEMPOTENCY_CONFLICT/)
  const approve = { action: "APPROVE", expenseId: expense.id, expectedRevision: 1, reason: "Facture contrôlée" }
  const races = await Promise.allSettled([run(approve), run(approve)])
  assert.equal(races.filter(x => x.status === "fulfilled").length, 1)
  assert.match(String((races.find(x => x.status === "rejected") as PromiseRejectedResult).reason), /EXPENSE_REVISION_CONFLICT/)
  expense = (races.find(x => x.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof run>>>).value.expense
  const mileage = (action: "READING" | "START" | "END" | "CORRECTION", body: unknown) => executeMileageCommand(f.truck.id, action, body, randomUUID(), f.deps())
  await mileage("READING", { mileage: 1000, expectedRevision: 0, occurredAt: "2020-01-01T00:00:00Z" })
  const started = await mileage("START", { mileage: 1000, expectedRevision: 1, occurredAt: "2020-01-10T00:00:00Z" })
  await mileage("END", { mileage: 1100, expectedRevision: 2, occurredAt: "2020-01-11T00:00:00Z", tripId: started.receipt.tripId })
  await mileage("CORRECTION", { mileage: 1010, expectedRevision: 3, entryId: started.receipt.entryId, expectedEffectiveEntryId: started.receipt.entryId, reason: "Relecture départ" })
  const crossing = await mileage("START", { mileage: 1100, expectedRevision: 4, occurredAt: "2020-01-31T23:00:00Z" })
  await mileage("END", { mileage: 1200, expectedRevision: 5, occurredAt: "2020-02-02T01:00:00Z", tripId: crossing.receipt.tripId })
  const period = { from: "2020-01-01T00:00:00Z", to: "2020-02-01T00:00:00Z", currency: "EUR" }
  const costs = () => readVehicleCosts(f.truck.id, period, f.deps())
  let result = await costs()
  assert.equal(result.realKm, 90); assert.equal(result.closedTrips, 1); assert.equal(result.crossingTrips, 1)
  assert.equal(result.total, "30.00"); assert.equal(result.costPerKm, "0.3333"); assert.equal(result.averagePurchasePricePerLitre, "2.0000"); assert.equal(result.fuelConsumption, null); assert.equal(result.completeCostStatus, "PARTIAL")
  const noKm = await readVehicleCosts(f.truck.id, { ...period, from: "2020-01-15T00:00:00Z" }, f.deps())
  assert.equal(noKm.realKm, 0); assert.equal(noKm.costPerKm, null)
  expense = (await run({ action: "ALLOCATE", expenseId: expense.id, expectedRevision: expense.revision, reason: "Répartition exacte", allocations: [{ amount: "0.10", mileageTripId: started.receipt.tripId }, { amount: "0.20", mileageTripId: null }] })).expense
  const allocationRows = await db.vehicleExpenseAllocation.findMany({ where: { expenseId: expense.id } })
  assert.equal(allocationRows.length, 2)
  await assert.rejects(run({ action: "ALLOCATE", expenseId: expense.id, expectedRevision: expense.revision, reason: "Trop élevé", allocations: [{ amount: "30.01", mileageTripId: null }] }), /OVER_ALLOCATION/)
  await assert.rejects(run({ action: "CORRECT", expenseId: expense.id, expectedRevision: expense.revision, reason: "Sous imputation", data: { ...data, amount: "0.20" } }), /OVER_ALLOCATION/)
  expense = (await run({ action: "ALLOCATE", expenseId: expense.id, expectedRevision: expense.revision, reason: "Effacer pour test SQL", allocations: [] })).expense
  const rawConcurrency = await Promise.allSettled([
    db.vehicleExpenseAllocation.create({ data: { id: randomUUID(), companyId: f.company.id, truckId: f.truck.id, expenseId: expense.id, mileageTripId: null, amount: "20.00" } }),
    db.vehicleExpenseAllocation.create({ data: { id: randomUUID(), companyId: f.company.id, truckId: f.truck.id, expenseId: expense.id, mileageTripId: started.receipt.tripId!, amount: "20.00" } }),
  ])
  assert.equal(rawConcurrency.filter(x => x.status === "fulfilled").length, 1)
  assert.match(String((rawConcurrency.find(x => x.status === "rejected") as PromiseRejectedResult).reason), /OVER_ALLOCATION/)
  // La note historique n'a aucune devise : confirmation explicite et montant exact obligatoires.
  const employee = await db.employee.findFirstOrThrow({ where: { userId: f.user.id, companyId: f.company.id } })
  const source = await db.expenseReport.create({ data: { companyId: f.company.id, employeeId: employee.id, date: new Date("2020-01-15T00:00:00Z"), amount: 30, category: "TRANSPORT", description: "Ticket carburant", status: "APPROVED" } })
  await assert.rejects(run({ action: "RECONCILE", expenseId: expense.id, expectedRevision: expense.revision, reason: "Source test", sourceExpenseReportId: source.id, confirmedAmount: "29.00", confirmedCurrency: "EUR" }), /SOURCE_AMOUNT_CURRENCY_CONFLICT/)
  expense = (await run({ action: "RECONCILE", expenseId: expense.id, expectedRevision: expense.revision, reason: "Ticket rapproché", sourceExpenseReportId: source.id, confirmedAmount: "30.00", confirmedCurrency: "EUR" })).expense
  assert.equal(expense.status, "PENDING"); assert.equal((await costs()).total, "0.00")
  expense = (await run({ action: "APPROVE", expenseId: expense.id, expectedRevision: expense.revision, reason: "Source et devise vérifiées" })).expense
  assert.equal((await costs()).total, "30.00") // jamais 60 avec note + projection
  const second = (await run({ action: "CREATE", data: { ...data, category: "OTHER", litres: null } })).expense
  await assert.rejects(run({ action: "RECONCILE", expenseId: second.id, expectedRevision: second.revision, reason: "Tentative doublon", sourceExpenseReportId: source.id, confirmedAmount: "30.00", confirmedCurrency: "EUR" }), /EXPENSE_DUPLICATE_SOURCE_OR_RECEIPT/)
  await db.expenseReport.update({ where: { id: source.id }, data: { status: "REJECTED" } })
  result = await costs(); assert.equal(result.total, "0.00"); assert.equal(result.excludedSource, 1)
  await assert.rejects(run({ action: "APPROVE", expenseId: expense.id, expectedRevision: expense.revision, reason: "Source refusée" }), /SOURCE_RECONCILIATION_REQUIRED/)
  await db.expenseReport.delete({ where: { id: source.id } })
  assert.ok(await db.vehicleExpense.findUnique({ where: { id: expense.id } }))
  const listed = await readExpenses(f.truck.id, f.deps())
  assert.equal(listed.expenses.find(e => e.id === expense.id)?.sourceWarning, "SOURCE_MISSING")
  // Contrôles tenant et rôle effectif relus dans la transaction.
  await assert.rejects(run({ action: "CREATE", data }, randomUUID(), f.deps(), f.otherTruck.id), /TRUCK_NOT_FOUND/)
  const foreignTripTruck = await db.truck.create({ data: { companyId: f.otherCompany.id, matricule: randomUUID() } })
  await assert.rejects(db.vehicleExpenseAllocation.create({ data: { companyId: f.otherCompany.id, truckId: foreignTripTruck.id, expenseId: expense.id, mileageTripId: started.receipt.tripId!, amount: "0.01" } }))
  await db.employee.update({ where: { id: employee.id }, data: { role: "EMPLOYEE" } })
  await assert.rejects(readExpenses(f.truck.id, f.deps()), /FORBIDDEN/)
  await assert.rejects(run({ action: "CREATE", data }), /FORBIDDEN/)
  await db.employee.update({ where: { id: employee.id }, data: { role: "ADMIN" } })
  // Historique audité immuable ; annulé ne compte plus.
  expense = (await run({ action: "CANCEL", expenseId: expense.id, expectedRevision: expense.revision, reason: "Annulation métier" })).expense
  const audit = await db.vehicleExpenseCommand.findFirstOrThrow({ where: { expenseId: expense.id } })
  await assert.rejects(db.vehicleExpenseCommand.update({ where: { id: audit.id }, data: { reason: "altéré" } }), /EXPENSE_AUDIT_IMMUTABLE/)
  await assert.rejects(db.vehicleExpense.delete({ where: { id: expense.id } }), /EXPENSE_AUDIT_IMMUTABLE/)
  await assert.rejects(run({ action: "APPROVE", expenseId: expense.id, expectedRevision: expense.revision, reason: "Trop tard" }), /EXPENSE_CANCELLED/)
 } finally { await db.$disconnect() }
})
