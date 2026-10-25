import assert from "node:assert/strict";
import { test } from "node:test";
import { civilTimeToIso, selectApprovedTourImport } from "../../../src/lib/vehicules/v3/tour-time";
test("Company civil time conversion is independent from device timezone", () => {
    assert.equal(civilTimeToIso("2026-07-01T08:00", "Europe/Paris"), "2026-07-01T06:00:00.000Z");
    assert.equal(civilTimeToIso("2026-01-01T00:00", "America/Los_Angeles"), "2026-01-01T08:00:00.000Z");
    assert.equal(civilTimeToIso("2026-07-01T00:00", "America/Los_Angeles"), "2026-07-01T07:00:00.000Z");
    const previous = process.env.TZ;
    try {
        process.env.TZ = "Africa/Libreville";
        const a = civilTimeToIso("2026-07-01T08:00", "Europe/Paris");
        process.env.TZ = "America/New_York";
        assert.equal(civilTimeToIso("2026-07-01T08:00", "Europe/Paris"), a);
    }
    finally {
        if (previous)
            process.env.TZ = previous;
        else
            delete process.env.TZ;
    }
});
test("Impossible and ambiguous DST civil hours are refused rather than guessed", () => {
    for (const [value, zone] of [["2026-03-29T02:30", "Europe/Paris"], ["2026-03-08T02:30", "America/Los_Angeles"]])
        assert.throws(() => civilTimeToIso(value, zone), /NONEXISTENT_CIVIL_TIME/);
    for (const [value, zone] of [["2026-10-25T02:30", "Europe/Paris"], ["2026-11-01T01:30", "America/Los_Angeles"]])
        assert.throws(() => civilTimeToIso(value, zone), /AMBIGUOUS_CIVIL_TIME/);
    assert.throws(() => civilTimeToIso("2026-02-30T08:00", "Europe/Paris"), /INVALID_CIVIL_TIME/);
});
test("Only exact approved import revision in current list prepopulates tour", () => {
    const approved = { id: "source", revision: 3, status: "APPROVED", candidates: [{ label: "Chantier", address: "10 rue de Paris", confirmed: true }] };
    assert.deepEqual(selectApprovedTourImport([approved], "source", 3), approved);
    for (const rows of [[], [{ ...approved, revision: 4 }], [{ ...approved, status: "CONSUMED" }], [{ ...approved, candidates: [{ ...approved.candidates[0], confirmed: false }] }]])
        assert.throws(() => selectApprovedTourImport(rows, "source", 3), /IMPORT_UNAVAILABLE/);
});
