// Module Tâches V1 — Validation & normalisation du contrat d'entrée (aucune DB).
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  parseCreateTaskInput,
  parseDueDateYmd,
  taskFormDataToRaw,
  TITLE_MAX,
  DESCRIPTION_MAX,
  RESERVED_TASK_FIELDS,
} from "@/lib/tasks/task.schema"

function ok(input: unknown) {
  const r = parseCreateTaskInput(input)
  assert.equal(r.ok, true, `attendu ok, reçu: ${r.ok ? "" : r.message}`)
  if (!r.ok) throw new Error("unreachable")
  return r.data
}

function ko(input: unknown): void {
  const r = parseCreateTaskInput(input)
  assert.equal(r.ok, false)
}

describe("parseCreateTaskInput — titre", () => {
  it("titre absent → refusé", () => ko({}))
  it("titre vide → refusé", () => ko({ title: "" }))
  it("titre blanc → refusé", () => ko({ title: "   " }))
  it("titre non textuel (nombre) → refusé", () => ko({ title: 42 }))
  it("titre trop long → refusé", () => ko({ title: "a".repeat(TITLE_MAX + 1) }))
  it("titre limite accepté et trimé", () => {
    const d = ok({ title: `  ${"a".repeat(TITLE_MAX)}  ` })
    assert.equal(d.title.length, TITLE_MAX)
  })
})

describe("parseCreateTaskInput — defaults & enums", () => {
  it("statut/priorité par défaut quand absents", () => {
    const d = ok({ title: "T" })
    assert.equal(d.status, "TODO")
    assert.equal(d.priority, "MEDIUM")
  })
  it("statut/priorité vides (champ présent) → refusé (defaults uniquement si absent)", () => {
    ko({ title: "T", status: "" })
    ko({ title: "T", priority: "" })
  })
  it("enums valides respectés", () => {
    const d = ok({ title: "T", status: "IN_PROGRESS", priority: "HIGH" })
    assert.equal(d.status, "IN_PROGRESS")
    assert.equal(d.priority, "HIGH")
  })
  it("enum entouré d'espaces → refusé (valeur exacte exigée)", () => {
    ko({ title: "T", status: " TODO " })
    ko({ title: "T", priority: " HIGH " })
  })
  it("statut invalide → refusé", () => ko({ title: "T", status: "ARCHIVED" }))
  it("priorité invalide → refusé", () => ko({ title: "T", priority: "URGENT" }))
})

describe("parseCreateTaskInput — description", () => {
  it("absente → null", () => assert.equal(ok({ title: "T" }).description, null))
  it("vide → null", () => assert.equal(ok({ title: "T", description: "   " }).description, null))
  it("trop longue → refusée", () =>
    ko({ title: "T", description: "a".repeat(DESCRIPTION_MAX + 1) }))
  it("valide → trimée", () =>
    assert.equal(ok({ title: "T", description: "  détail  " }).description, "détail"))
})

describe("parseCreateTaskInput — échéance", () => {
  it("absente → null", () => assert.equal(ok({ title: "T" }).dueDate, null))
  it("vide → null", () => assert.equal(ok({ title: "T", dueDate: "" }).dueDate, null))
  it("date valide → minuit UTC", () => {
    const d = ok({ title: "T", dueDate: "2026-03-15" })
    assert.ok(d.dueDate instanceof Date)
    assert.equal(d.dueDate!.toISOString(), "2026-03-15T00:00:00.000Z")
  })
  it("date passée autorisée", () => {
    const d = ok({ title: "T", dueDate: "2000-01-01" })
    assert.equal(d.dueDate!.toISOString(), "2000-01-01T00:00:00.000Z")
  })
  it("date impossible (30 février) → refusée", () => ko({ title: "T", dueDate: "2026-02-30" }))
  it("mois invalide → refusé", () => ko({ title: "T", dueDate: "2026-13-01" }))
  it("format non ISO → refusé", () => ko({ title: "T", dueDate: "15/03/2026" }))
})

describe("parseDueDateYmd", () => {
  it("rejette 2025-02-29 (non bissextile)", () => assert.equal(parseDueDateYmd("2025-02-29"), null))
  it("accepte 2024-02-29 (bissextile)", () =>
    assert.equal(parseDueDateYmd("2024-02-29")!.toISOString(), "2024-02-29T00:00:00.000Z"))
})

describe("parseCreateTaskInput — références facultatives", () => {
  it("omises → null", () => {
    const d = ok({ title: "T" })
    assert.equal(d.assigneeId, null)
    assert.equal(d.worksiteId, null)
  })
  it("vides → null", () => {
    const d = ok({ title: "T", assigneeId: "", worksiteId: "  " })
    assert.equal(d.assigneeId, null)
    assert.equal(d.worksiteId, null)
  })
  it("fournies → trimées", () => {
    const d = ok({ title: "T", assigneeId: " emp1 ", worksiteId: " ws1 " })
    assert.equal(d.assigneeId, "emp1")
    assert.equal(d.worksiteId, "ws1")
  })
  it("identifiant aberrant (trop long) → refusé", () =>
    ko({ title: "T", assigneeId: "x".repeat(500) }))
})

describe("parseCreateTaskInput — robustesse & champs réservés", () => {
  it("entrée non-objet → refusée", () => {
    ko(null)
    ko("x")
    ko(42)
    ko([])
  })
  it("fichier (non string) → refusé", () => {
    ko({ title: "T", description: new Uint8Array([1, 2, 3]) })
  })
  it("doublon (tableau) → refusé", () => {
    ko({ title: ["A", "B"] })
  })
  for (const field of RESERVED_TASK_FIELDS) {
    it(`champ réservé « ${field} » fourni → refusé`, () => {
      ko({ title: "T", [field]: "injection" })
    })
  }
  it("champ réservé vide (présent) → refusé (fourni par le client)", () => {
    ko({ title: "T", companyId: "" })
    ko({ title: "T", createdById: "" })
  })
  it("champ réservé null/undefined → toléré (non fourni)", () => {
    ok({ title: "T", companyId: null })
    ok({ title: "T", createdById: undefined })
  })
})

describe("taskFormDataToRaw", () => {
  it("collapse les champs simples", () => {
    const fd = new FormData()
    fd.append("title", "T")
    fd.append("status", "DONE")
    const raw = taskFormDataToRaw(fd)
    assert.equal(raw.title, "T")
    assert.equal(raw.status, "DONE")
  })
  it("un champ dupliqué devient un tableau (refusé en aval)", () => {
    const fd = new FormData()
    fd.append("title", "A")
    fd.append("title", "B")
    const raw = taskFormDataToRaw(fd)
    assert.ok(Array.isArray(raw.title))
    const r = parseCreateTaskInput(raw)
    assert.equal(r.ok, false)
  })
  it("un FormData nominal passe la validation", () => {
    const fd = new FormData()
    fd.append("title", "Préparer devis")
    fd.append("priority", "HIGH")
    fd.append("assigneeId", "emp1")
    const d = ok(taskFormDataToRaw(fd))
    assert.equal(d.title, "Préparer devis")
    assert.equal(d.priority, "HIGH")
    assert.equal(d.assigneeId, "emp1")
  })
})
