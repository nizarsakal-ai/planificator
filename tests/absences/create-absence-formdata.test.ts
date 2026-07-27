/**
 * Absences — validation FormData / Zod / mapper persistance
 * (repro "Expected string, received null" + réserves revue).
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  appendCreateAbsenceFormData,
  createAbsenceSchema,
  emptyToUndefined,
  formDataString,
  parseCreateAbsenceFormData,
  parseCreateAbsenceInput,
  toAbsencePersistenceData,
  type CreateAbsenceInput,
} from "@/lib/validations/absence"

function fullInput(
  overrides: Partial<CreateAbsenceInput> = {}
): CreateAbsenceInput {
  return {
    employeeId: "emp-1",
    type: "VACATION",
    startDate: "2026-07-27",
    endDate: "2026-07-28",
    reason: "Congés d'été",
    ...overrides,
  }
}

describe("emptyToUndefined / formDataString", () => {
  it("ne conserve jamais null pour une string", () => {
    assert.equal(emptyToUndefined(null), undefined)
    assert.equal(emptyToUndefined(""), undefined)
    assert.equal(emptyToUndefined("  "), undefined)
    assert.equal(emptyToUndefined("ok"), "ok")
  })

  it("lit FormData sans produire null", () => {
    const fd = new FormData()
    fd.set("reason", "")
    assert.equal(formDataString(fd, "reason"), undefined)
    assert.equal(formDataString(fd, "missing"), undefined)
    fd.set("reason", "Motif")
    assert.equal(formDataString(fd, "reason"), "Motif")
  })

  it("rejette File / non-string sans String(value)", () => {
    const fd = new FormData()
    const file = new File(["x"], "x.txt", { type: "text/plain" })
    fd.set("reason", file)
    const result = formDataString(fd, "reason")
    assert.equal(result, undefined)
    assert.notEqual(result, "[object File]")
  })
})

describe("createAbsenceSchema / parseCreateAbsenceInput", () => {
  it("accepte une création complète", () => {
    const parsed = parseCreateAbsenceInput(fullInput())
    assert.equal(parsed.success, true)
    if (parsed.success) {
      assert.equal(parsed.data.reason, "Congés d'été")
      assert.equal(Object.values(parsed.data).includes(null as never), false)
    }
  })

  it("accepte reason absent / undefined / null / vide → undefined", () => {
    for (const reason of [undefined, null, "", "   "] as const) {
      const parsed = parseCreateAbsenceInput(
        fullInput({ reason: reason as never })
      )
      assert.equal(parsed.success, true, String(reason))
      if (parsed.success) {
        assert.equal(parsed.data.reason, undefined)
      }
    }
  })

  it("rejette employeeId manquant sans masquer par nullable", () => {
    const parsed = parseCreateAbsenceInput(fullInput({ employeeId: "" }))
    assert.equal(parsed.success, false)
  })

  it("rejette un type d'absence invalide", () => {
    const parsed = parseCreateAbsenceInput(
      fullInput({ type: "NOPE" as never })
    )
    assert.equal(parsed.success, false)
  })

  it("rejette endDate < startDate", () => {
    const parsed = parseCreateAbsenceInput(
      fullInput({ startDate: "2026-07-28", endDate: "2026-07-27" })
    )
    assert.equal(parsed.success, false)
    if (!parsed.success) {
      assert.match(
        parsed.error.errors[0]?.message ?? "",
        /date de fin/i
      )
    }
  })
})

describe("chemins createAbsence / demanderAbsence — contrat partagé", () => {
  it("chemin createAbsence : FormData → parseCreateAbsenceFormData", () => {
    const fd = new FormData()
    appendCreateAbsenceFormData(fd, fullInput())
    const parsed = parseCreateAbsenceFormData(fd)
    assert.equal(parsed.success, true)
    if (parsed.success) {
      assert.equal(parsed.data.employeeId, "emp-1")
      assert.equal(parsed.data.reason, "Congés d'été")
    }
  })

  it("chemin demanderAbsence : input métier → parseCreateAbsenceInput", () => {
    // Simule l'injection employeeId côté action + champs FormData normalisés
    const fd = new FormData()
    fd.set("type", "SICK")
    fd.set("startDate", "2026-07-27")
    fd.set("endDate", "2026-07-27")
    // reason omis
    assert.equal(fd.get("reason"), null)

    const parsed = parseCreateAbsenceInput({
      employeeId: "emp-from-session",
      type: formDataString(fd, "type"),
      startDate: formDataString(fd, "startDate"),
      endDate: formDataString(fd, "endDate"),
      reason: formDataString(fd, "reason"),
    })
    assert.equal(parsed.success, true)
    if (parsed.success) {
      assert.equal(parsed.data.employeeId, "emp-from-session")
      assert.equal(parsed.data.reason, undefined)
    }
  })
})

describe("parseCreateAbsenceFormData — scénario AbsenceForm", () => {
  it("succès avec tous les champs (dont reason)", () => {
    const fd = new FormData()
    appendCreateAbsenceFormData(fd, fullInput())
    assert.equal(fd.get("reason"), "Congés d'été")

    const parsed = parseCreateAbsenceFormData(fd)
    assert.equal(parsed.success, true)
    if (parsed.success) {
      assert.deepEqual(
        {
          employeeId: parsed.data.employeeId,
          type: parsed.data.type,
          startDate: parsed.data.startDate,
          endDate: parsed.data.endDate,
          reason: parsed.data.reason,
        },
        fullInput()
      )
      for (const value of Object.values(parsed.data)) {
        assert.notEqual(value, null)
      }
    }
  })

  it("succès quand reason optionnel est omis (repro bug null)", () => {
    const fd = new FormData()
    fd.set("employeeId", "emp-1")
    fd.set("type", "SICK")
    fd.set("startDate", "2026-07-27")
    fd.set("endDate", "2026-07-27")
    assert.equal(fd.get("reason"), null)

    const parsed = parseCreateAbsenceFormData(fd)
    assert.equal(parsed.success, true)
    if (parsed.success) {
      assert.equal(parsed.data.reason, undefined)
    }
  })

  it("succès quand reason est une string vide (DemanderAbsenceDialog)", () => {
    const fd = new FormData()
    fd.set("employeeId", "emp-1")
    fd.set("type", "OTHER")
    fd.set("startDate", "2026-07-27")
    fd.set("endDate", "2026-07-29")
    fd.set("reason", "")

    const parsed = parseCreateAbsenceFormData(fd)
    assert.equal(parsed.success, true)
    if (parsed.success) {
      assert.equal(parsed.data.reason, undefined)
    }
  })

  it("appendCreateAbsenceFormData n'écrit jamais null / reason vide", () => {
    const fd = new FormData()
    appendCreateAbsenceFormData(fd, fullInput({ reason: undefined }))
    assert.equal(fd.has("reason"), false)
    assert.equal(fd.get("employeeId"), "emp-1")
  })
})

describe("toAbsencePersistenceData", () => {
  it("reason string → même string ; undefined → null", () => {
    const withReason = toAbsencePersistenceData(fullInput())
    assert.equal(withReason.reason, "Congés d'été")
    assert.ok(withReason.startDate instanceof Date)
    assert.ok(withReason.endDate instanceof Date)

    const without = toAbsencePersistenceData(fullInput({ reason: undefined }))
    assert.equal(without.reason, null)
  })
})

// Garde : le schéma exporté reste le seul contrat (utilisé via parseCreateAbsenceInput)
describe("contrat unique", () => {
  it("createAbsenceSchema reste aligné avec parseCreateAbsenceInput", () => {
    const viaSchema = createAbsenceSchema.safeParse(fullInput())
    const viaHelper = parseCreateAbsenceInput(fullInput())
    assert.equal(viaSchema.success, viaHelper.success)
    if (viaSchema.success && viaHelper.success) {
      assert.deepEqual(viaSchema.data, viaHelper.data)
    }
  })
})
