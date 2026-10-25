import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { Prisma } from "@prisma/client"
import { assertAllocationTotal, expenseEnabled, expenseHash, parseCostPeriod, parseExpenseCommand } from "../../src/lib/vehicules/v3/expense-domain"
const data = { category: "FUEL", occurredAt: "2020-01-01T12:00:00Z", amount: "0.30", currency: "EUR", litres: "0.123" }
test("exact decimal money/litres and strict payloads", () => {
  const command = parseExpenseCommand({ action: "CREATE", data }, randomUUID()).command
  assert.equal(command.action, "CREATE")
  assert.equal(assertAllocationTotal("0.30", [{ amount: "0.10", mileageTripId: "t" }, { amount: "0.20", mileageTripId: null }]).toFixed(2), "0.30")
  for (const invalid of [{ ...data, amount: 0.3 }, { ...data, amount: "0.001" }, { ...data, amount: "-1" }, { ...data, currency: "eur" }, { ...data, litres: "1.2345" }, { ...data, category: "INSURANCE" }, { ...data, companyId: "foreign" }, { ...data, amount: "Infinity" }, { ...data, amount: "1e2" }]) {
    assert.throws(() => parseExpenseCommand({ action: "CREATE", data: invalid }, randomUUID()), /INVALID_PAYLOAD/)
  }
  assert.throws(() => parseExpenseCommand({ action: "CREATE", data }, "bad"), /INVALID_IDEMPOTENCY_KEY/)
})
test("allocation cap and distinct targets", () => {
  assert.throws(() => assertAllocationTotal("0.30", [{ amount: "0.31", mileageTripId: null }]), /OVER_ALLOCATION/)
  assert.throws(() => assertAllocationTotal("0.30", [{ amount: "0.1", mileageTripId: null }, { amount: "0.1", mileageTripId: null }]), /DUPLICATE_ALLOCATION_TARGET/)
  assert.throws(() => assertAllocationTotal(new Prisma.Decimal("10.00"), [{ amount: "0", mileageTripId: null }]), /OVER_ALLOCATION/)
})
test("explicit revision/reason, tenant actor hashed, strict flag", () => {
  for (const action of ["APPROVE", "REJECT", "CANCEL"]) assert.equal(parseExpenseCommand({ action, expenseId: "a", expectedRevision: 1, reason: "vérifié" }, randomUUID()).command.action, action)
  assert.throws(() => parseExpenseCommand({ action: "APPROVE", expenseId: "a", expectedRevision: 1 }, randomUUID()), /INVALID_PAYLOAD/)
  const command = parseExpenseCommand({ action: "CREATE", data }, randomUUID()).command
  assert.notEqual(expenseHash(command, "a", "t", "u"), expenseHash(command, "b", "t", "u"))
  assert.notEqual(expenseHash(command, "a", "t", "u"), expenseHash(command, "a", "t", "v"))
  const previous = process.env.PLANIFICATOR_VEHICLES_V3_ENABLED
  try { for (const v of [undefined, "false", "1", "TRUE"]) { if (v === undefined) delete process.env.PLANIFICATOR_VEHICLES_V3_ENABLED; else process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = v; assert.equal(expenseEnabled(), false) } process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "true"; assert.equal(expenseEnabled(), true) } finally { if (previous === undefined) delete process.env.PLANIFICATOR_VEHICLES_V3_ENABLED; else process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = previous }
})
test("bounded half-open period and explicit timezone/currency", () => {
  assert.equal(parseCostPeriod("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z", "EUR").currency, "EUR")
  for (const [from, to, currency] of [["2026-01-01", "2026-02-01T00:00:00Z", "EUR"], ["2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "EUR"], ["2020-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "EUR"], ["2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z", "eur"]]) assert.throws(() => parseCostPeriod(from, to, currency), /INVALID_PERIOD/)
})
