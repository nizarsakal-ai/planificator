import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  MAX_MILEAGE,
  MileageDomainError,
  computeMileageRequestHash,
  getMileageTripDistance,
  parseMileageCommand,
  rebuildMileageProjection,
  resolveMileageHistory,
  validateMileageCorrection,
  validateNewOriginal,
  type MileageEntryRecord,
  type MileageTripRecord,
} from "@/lib/vehicules/mileage-domain"

const KEY = "94f59e4e-df0b-49e2-8fe6-a9c738ec1729"
const SCOPE = { companyId: "company-a", truckId: "truck-a", actorId: "user-a" }
const AT = new Date("2026-10-08T08:00:00.000Z")
const AFTER = new Date("2026-10-08T09:00:00.000Z")
const NOW = new Date("2026-10-08T10:00:00.000Z")

function entry(overrides: Partial<MileageEntryRecord> = {}): MileageEntryRecord {
  return {
    id: "reading-1", companyId: SCOPE.companyId, truckId: SCOPE.truckId,
    kind: "READING", mileage: 100, revision: 1, occurredAt: AT,
    rootEntryId: null, supersedesEntryId: null, correctionReason: null,
    ...overrides,
  }
}

function correction(overrides: Partial<MileageEntryRecord> = {}): MileageEntryRecord {
  return entry({
    id: "correction-1", kind: "CORRECTION", mileage: 110, revision: 2,
    occurredAt: null, rootEntryId: "reading-1", supersedesEntryId: "reading-1",
    correctionReason: "Erreur de saisie", ...overrides,
  })
}

function expectCode(action: () => unknown, code: string, status?: number) {
  assert.throws(action, (error) => error instanceof MileageDomainError
    && error.code === code && (status === undefined || error.status === status))
}

describe("mileage command validation", () => {
  it("parses the four command types, with server context excluded", () => {
    const reading = parseMileageCommand("READING", { mileage: 0, expectedRevision: 0 }, KEY)
    assert.deepEqual(reading, { type: "READING", mileage: 0, expectedRevision: 0, idempotencyKey: KEY })
    assert.deepEqual(parseMileageCommand("START", { mileage: 5, expectedRevision: 1 }, KEY), {
      type: "START", mileage: 5, expectedRevision: 1, idempotencyKey: KEY, worksiteId: null,
    })
    const end = parseMileageCommand("END", { mileage: 15, expectedRevision: 2, tripId: " trip-1 " }, KEY)
    assert.equal(end.type, "END")
    if (end.type === "END") assert.equal(end.tripId, "trip-1")
    const corrected = parseMileageCommand("CORRECTION", {
      mileage: 16, expectedRevision: 3, entryId: "arrival", expectedEffectiveEntryId: "arrival", reason: "  Erreur  ",
    }, KEY)
    assert.equal(corrected.type, "CORRECTION")
    if (corrected.type === "CORRECTION") assert.equal(corrected.reason, "Erreur")
  })

  for (const value of [-1, 1.5, MAX_MILEAGE + 1, Number.NaN, Infinity, "100", null]) {
    it(`rejects invalid mileage ${String(value)}`, () => {
      expectCode(() => parseMileageCommand("READING", { mileage: value, expectedRevision: 0 }, KEY), "INVALID_PAYLOAD", 400)
    })
  }

  it("accepts the exact upper bound", () => {
    assert.equal(parseMileageCommand("READING", { mileage: MAX_MILEAGE, expectedRevision: 0 }, KEY).mileage, MAX_MILEAGE)
  })

  for (const value of [undefined, -1, 0.5, "0", 2_147_483_648]) {
    it(`requires a valid expected revision: ${String(value)}`, () => {
      expectCode(() => parseMileageCommand("READING", { mileage: 0, expectedRevision: value }, KEY), "INVALID_PAYLOAD", 400)
    })
  }

  it("requires a UUID idempotency header and normalizes its case", () => {
    for (const key of [null, undefined, "", "not-a-uuid", `${KEY},${KEY}`]) {
      expectCode(() => parseMileageCommand("READING", { mileage: 0, expectedRevision: 0 }, key), "INVALID_IDEMPOTENCY_KEY", 400)
    }
    assert.equal(parseMileageCommand("READING", { mileage: 0, expectedRevision: 0 }, ` ${KEY.toUpperCase()} `).idempotencyKey, KEY)
  })

  it("requires an explicit timezone for a provided original timestamp", () => {
    for (const occurredAt of ["2026-10-08", "2026-10-08T10:00:00", "2026-02-30T10:00:00Z", null, "not-a-date"]) {
      expectCode(() => parseMileageCommand("READING", { mileage: 0, expectedRevision: 0, occurredAt }, KEY), "INVALID_PAYLOAD", 400)
    }
    const command = parseMileageCommand("READING", { mileage: 0, expectedRevision: 0, occurredAt: "2026-10-08T10:00:00+02:00" }, KEY)
    if (command.type === "READING") assert.equal(command.occurredAt?.toISOString(), AT.toISOString())
  })

  it("rejects submitted tenancy, authorship, driver, team, type and extra fields", () => {
    for (const field of ["companyId", "actorId", "createdById", "teamId", "chauffeurId", "type", "distance"]) {
      expectCode(() => parseMileageCommand("START", { mileage: 0, expectedRevision: 0, [field]: "injected" }, KEY), "INVALID_PAYLOAD", 400)
    }
    expectCode(() => parseMileageCommand("END", { mileage: 0, expectedRevision: 0 }, KEY), "INVALID_PAYLOAD", 400)
    expectCode(() => parseMileageCommand("READING", { mileage: 0, expectedRevision: 0, worksiteId: "site" }, KEY), "INVALID_PAYLOAD", 400)
  })

  it("requires correction reason and tip, and forbids a new observation time", () => {
    const body = { mileage: 110, expectedRevision: 1, entryId: "original", expectedEffectiveEntryId: "original", reason: "Erreur" }
    for (const invalid of [
      { ...body, reason: "  " }, { ...body, reason: null }, { ...body, expectedEffectiveEntryId: "" },
      { ...body, entryId: "" }, { ...body, occurredAt: AT.toISOString() },
    ]) expectCode(() => parseMileageCommand("CORRECTION", invalid, KEY), "INVALID_PAYLOAD", 400)
  })
})

describe("deterministic idempotency fingerprint", () => {
  it("canonicalizes property order, UUID case and equivalent timezone offsets", () => {
    const a = parseMileageCommand("READING", { mileage: 100, expectedRevision: 1, occurredAt: AT.toISOString() }, KEY)
    const b = parseMileageCommand("READING", { occurredAt: "2026-10-08T10:00:00+02:00", expectedRevision: 1, mileage: 100 }, KEY.toUpperCase())
    assert.match(computeMileageRequestHash(a, SCOPE), /^[0-9a-f]{64}$/)
    assert.equal(computeMileageRequestHash(a, SCOPE), computeMileageRequestHash(b, SCOPE))
  })

  it("keeps an absent time stable, separate from an explicit instant", () => {
    const a = parseMileageCommand("READING", { mileage: 100, expectedRevision: 0 }, KEY)
    assert.equal(computeMileageRequestHash(a, SCOPE), computeMileageRequestHash(a, SCOPE))
    const b = parseMileageCommand("READING", { mileage: 100, expectedRevision: 0, occurredAt: AT.toISOString() }, KEY)
    assert.notEqual(computeMileageRequestHash(a, SCOPE), computeMileageRequestHash(b, SCOPE))
  })

  it("binds scope, actor, command type, revision, value and context", () => {
    const body = { mileage: 100, expectedRevision: 0 }
    const command = parseMileageCommand("START", body, KEY)
    const hash = computeMileageRequestHash(command, SCOPE)
    for (const scope of [
      { ...SCOPE, companyId: "company-b" }, { ...SCOPE, truckId: "truck-b" }, { ...SCOPE, actorId: "user-b" },
    ]) assert.notEqual(hash, computeMileageRequestHash(command, scope))
    for (const variant of [
      parseMileageCommand("READING", body, KEY),
      parseMileageCommand("START", { ...body, mileage: 101 }, KEY),
      parseMileageCommand("START", { ...body, expectedRevision: 1 }, KEY),
      parseMileageCommand("START", { ...body, worksiteId: "site" }, KEY),
    ]) assert.notEqual(hash, computeMileageRequestHash(variant, SCOPE))
    assert.equal(hash, computeMileageRequestHash(parseMileageCommand("START", { ...body, worksiteId: null }, KEY), SCOPE))
  })

  it("binds arrival target and correction target, expected tip and trimmed reason", () => {
    const body = { mileage: 100, expectedRevision: 1, tripId: "trip-1" }
    const hash = computeMileageRequestHash(parseMileageCommand("END", body, KEY), SCOPE)
    assert.notEqual(hash, computeMileageRequestHash(parseMileageCommand("END", { ...body, tripId: "trip-2" }, KEY), SCOPE))
    const correctionBody = { mileage: 110, expectedRevision: 1, entryId: "root", expectedEffectiveEntryId: "root", reason: "Erreur" }
    const correctedHash = computeMileageRequestHash(parseMileageCommand("CORRECTION", correctionBody, KEY), SCOPE)
    for (const variant of [
      { ...correctionBody, entryId: "other-root" }, { ...correctionBody, expectedEffectiveEntryId: "correction-1" },
      { ...correctionBody, reason: "Autre erreur" },
    ]) assert.notEqual(correctedHash, computeMileageRequestHash(parseMileageCommand("CORRECTION", variant, KEY), SCOPE))
    assert.equal(correctedHash, computeMileageRequestHash(parseMileageCommand("CORRECTION", { ...correctionBody, reason: " Erreur " }, KEY), SCOPE))
  })
})

describe("authoritative mileage history and projection", () => {
  it("keeps unknown null and treats an initial zero as known", () => {
    assert.deepEqual(rebuildMileageProjection([]), { currentMileage: null, currentMileageEntryId: null, mileageRevision: 0 })
    assert.deepEqual(rebuildMileageProjection([entry({ mileage: 0 })]), { currentMileage: 0, currentMileageEntryId: "reading-1", mileageRevision: 1 })
  })

  it("rebuilds using effective value of latest ORIGINAL and max command revision", () => {
    const rows = [
      entry(), entry({ id: "reading-2", mileage: 150, revision: 2, occurredAt: AFTER }),
      correction({ revision: 3 }),
      correction({ id: "correction-2", revision: 4, mileage: 170, rootEntryId: "reading-2", supersedesEntryId: "reading-2" }),
      correction({ id: "correction-3", revision: 5, mileage: 120, supersedesEntryId: "correction-1" }),
    ]
    const shuffled = Object.freeze([rows[4], rows[1], rows[3], rows[0], rows[2]].map((row) => Object.freeze(row)))
    const before = JSON.stringify(shuffled)
    const history = resolveMileageHistory(shuffled)
    assert.deepEqual(history.projection, { currentMileage: 170, currentMileageEntryId: "correction-2", mileageRevision: 5 })
    assert.equal(history.byOriginalId.get("reading-1")?.effective.id, "correction-3")
    assert.equal(history.byOriginalId.get("reading-1")?.original.occurredAt.toISOString(), AT.toISOString())
    assert.equal(JSON.stringify(shuffled), before)
  })

  it("orders observations sharing the same instant by original revision", () => {
    const history = resolveMileageHistory([
      entry(), entry({ id: "second", revision: 2, mileage: 101 }),
      correction({ revision: 3, mileage: 100 }),
    ])
    assert.deepEqual(history.originals.map((row) => row.original.id), ["reading-1", "second"])
    assert.equal(history.projection.currentMileageEntryId, "second")
    assert.equal(history.projection.mileageRevision, 3)
  })

  it("checks the final effective values, not the original mistaken readings", () => {
    const history = resolveMileageHistory([
      entry({ mileage: 110 }), entry({ id: "second", revision: 2, mileage: 100, occurredAt: AFTER }),
      correction({ revision: 3, mileage: 90 }),
    ])
    assert.equal(history.projection.currentMileage, 100)
  })

  const corruptCases: [string, () => MileageEntryRecord[]][] = [
    ["duplicate ID", () => [entry(), entry({ revision: 2 })]],
    ["duplicate revision", () => [entry(), entry({ id: "other" })]],
    ["revision gap", () => [entry({ revision: 2 })]],
    ["cross tenant", () => [entry(), correction({ companyId: "other" })]],
    ["cross truck", () => [entry(), correction({ truckId: "other" })]],
    ["missing root", () => [entry(), correction({ rootEntryId: "missing" })]],
    ["missing parent", () => [entry(), correction({ supersedesEntryId: "missing" })]],
    ["correction branching", () => [entry(), correction(), correction({ id: "branch", revision: 3 })]],
    ["correction root is correction", () => [entry(), correction(), correction({ id: "bad", revision: 3, rootEntryId: "correction-1", supersedesEntryId: "correction-1" })]],
    ["self reference", () => [entry(), correction({ supersedesEntryId: "correction-1" })]],
    ["non-null correction instant", () => [entry(), correction({ occurredAt: AFTER })]],
    ["empty reason", () => [entry(), correction({ correctionReason: "  " })]],
    ["reason on original", () => [entry({ correctionReason: "unexpected" })]],
    ["link on original", () => [entry({ rootEntryId: "unexpected" })]],
    ["null original instant", () => [entry({ occurredAt: null })]],
    ["invalid original instant", () => [entry({ occurredAt: new Date("invalid") })]],
    ["negative value", () => [entry({ mileage: -1 })]],
    ["fractional value", () => [entry({ mileage: 0.5 })]],
    ["excessive value", () => [entry({ mileage: MAX_MILEAGE + 1 })]],
    ["out of order originals", () => [entry({ occurredAt: AFTER }), entry({ id: "second", revision: 2 })]],
    ["effective regression", () => [entry(), entry({ id: "second", revision: 2, mileage: 99, occurredAt: AFTER })]],
  ]
  for (const [name, rows] of corruptCases) {
    it(`fails closed on ${name}`, () => expectCode(() => resolveMileageHistory(rows()), "MILEAGE_HISTORY_CORRUPT", 500))
  }
})

describe("new original validation", () => {
  it("accepts initial, equal mileage and equal instant observations", () => {
    validateNewOriginal(resolveMileageHistory([]), 0, AT, NOW)
    validateNewOriginal(resolveMileageHistory([entry()]), 100, AT, NOW)
    validateNewOriginal(resolveMileageHistory([entry()]), 101, AFTER, NOW)
  })
  it("rejects negative or fractional direct-domain values", () => {
    for (const mileage of [-1, 1.5, MAX_MILEAGE + 1]) {
      expectCode(() => validateNewOriginal(resolveMileageHistory([]), mileage, AT, NOW), "INVALID_PAYLOAD", 400)
    }
  })
  it("rejects a future instant", () => {
    expectCode(() => validateNewOriginal(resolveMileageHistory([]), 0, new Date(NOW.getTime() + 1), NOW), "MILEAGE_FUTURE_DATE", 422)
  })
  it("rejects an out-of-order observation", () => {
    expectCode(() => validateNewOriginal(resolveMileageHistory([entry()]), 101, new Date(AT.getTime() - 1), NOW), "MILEAGE_OUT_OF_ORDER")
  })
  it("compares a new observation with the corrected current value", () => {
    expectCode(() => validateNewOriginal(resolveMileageHistory([entry(), correction()]), 109, AFTER, NOW), "MILEAGE_REGRESSION")
  })
})

describe("corrections and trip distances", () => {
  const rows = () => [
    entry({ id: "departure", kind: "DEPARTURE", mileage: 100 }),
    entry({ id: "during-trip", revision: 2, mileage: 120, occurredAt: AFTER }),
    entry({ id: "arrival", kind: "ARRIVAL", revision: 3, mileage: 150, occurredAt: NOW }),
  ]
  const trip: MileageTripRecord = {
    id: "trip", companyId: SCOPE.companyId, truckId: SCOPE.truckId, startEntryId: "departure", endEntryId: "arrival",
  }

  it("an open trip has no distance; a standalone reading does not close it", () => {
    assert.equal(getMileageTripDistance(resolveMileageHistory(rows().slice(0, 2)), { ...trip, endEntryId: null }), null)
    assert.equal(getMileageTripDistance(resolveMileageHistory(rows()), trip), 50)
  })

  it("corrections change only effective values; original endpoints stay stable", () => {
    const history = resolveMileageHistory([
      ...rows(),
      correction({ id: "departure-correction", revision: 4, mileage: 110, rootEntryId: "departure", supersedesEntryId: "departure" }),
      correction({ id: "arrival-correction", revision: 5, mileage: 160, rootEntryId: "arrival", supersedesEntryId: "arrival" }),
    ])
    const correctedRoot = validateMileageCorrection(history, {
      entryId: "departure-correction", expectedEffectiveEntryId: "departure-correction", mileage: 115,
    }, [trip])
    assert.equal(correctedRoot.original.id, "departure")
    assert.equal(correctedRoot.original.occurredAt.toISOString(), AT.toISOString())
    assert.equal(getMileageTripDistance(history, trip), 50)
    assert.equal(trip.startEntryId, "departure")
    assert.equal(trip.endEntryId, "arrival")
  })

  it("rejects stale correction tip before a branch can be appended", () => {
    const history = resolveMileageHistory([entry(), correction()])
    expectCode(() => validateMileageCorrection(history, {
      entryId: "reading-1", expectedEffectiveEntryId: "reading-1", mileage: 120,
    }, []), "MILEAGE_CORRECTION_CONFLICT")
  })

  it("enforces both neighbors, including observations made during an open trip", () => {
    const history = resolveMileageHistory(rows())
    for (const mileage of [99, 151]) {
      expectCode(() => validateMileageCorrection(history, {
        entryId: "during-trip", expectedEffectiveEntryId: "during-trip", mileage,
      }, [trip]), "MILEAGE_REGRESSION")
    }
    expectCode(() => validateMileageCorrection(history, {
      entryId: "departure", expectedEffectiveEntryId: "departure", mileage: 121,
    }, [trip]), "MILEAGE_REGRESSION")
    expectCode(() => validateMileageCorrection(history, {
      entryId: "arrival", expectedEffectiveEntryId: "arrival", mileage: 119,
    }, [trip]), "MILEAGE_REGRESSION")
    for (const mileage of [100, 150]) {
      validateMileageCorrection(history, { entryId: "during-trip", expectedEffectiveEntryId: "during-trip", mileage }, [trip])
    }
  })

  it("has no age restriction and returns a clear error for unknown entries", () => {
    const history = resolveMileageHistory([entry({ occurredAt: new Date("2000-01-01T00:00:00Z") })])
    validateMileageCorrection(history, { entryId: "reading-1", expectedEffectiveEntryId: "reading-1", mileage: 1 }, [])
    expectCode(() => validateMileageCorrection(history, { entryId: "missing", expectedEffectiveEntryId: "missing", mileage: 1 }, []), "MILEAGE_ENTRY_NOT_FOUND", 404)
  })

  it("rejects corrupt trip endpoints or tenant/truck mismatch", () => {
    const history = resolveMileageHistory(rows())
    for (const invalid of [
      { ...trip, companyId: "company-b" }, { ...trip, truckId: "truck-b" },
      { ...trip, startEntryId: "missing" }, { ...trip, startEntryId: "during-trip" },
      { ...trip, endEntryId: "missing" }, { ...trip, endEntryId: "departure" },
      { ...trip, endEntryId: "during-trip" },
    ]) expectCode(() => getMileageTripDistance(history, invalid), "MILEAGE_HISTORY_CORRUPT", 500)
  })
})
