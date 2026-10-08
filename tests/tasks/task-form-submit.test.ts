// Module Tâches V1 — Comportement de soumission du formulaire (action simulée, aucune DB).
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  buildTaskFormData,
  submitTaskForm,
  TASK_CREATED_MESSAGE,
  type CreateTaskActionResult,
  type TaskFormValues,
} from "@/lib/tasks/task-form.submit"

function values(over: Partial<TaskFormValues> = {}): TaskFormValues {
  return { title: "T", status: "TODO", priority: "MEDIUM", ...over }
}

type Recorder = {
  deps: Parameters<typeof submitTaskForm>[1]
  sent: FormData[]
  success: string[]
  error: string[]
  resetCount: () => number
  successCloseCount: () => number
}

function recorder(result: CreateTaskActionResult): Recorder {
  const sent: FormData[] = []
  const success: string[] = []
  const error: string[] = []
  let resets = 0
  let closes = 0
  return {
    sent,
    success,
    error,
    resetCount: () => resets,
    successCloseCount: () => closes,
    deps: {
      createTask: async (fd) => {
        sent.push(fd)
        return result
      },
      notifySuccess: (m) => success.push(m),
      notifyError: (m) => error.push(m),
      reset: () => {
        resets += 1
      },
      onSuccess: () => {
        closes += 1
      },
    },
  }
}

describe("buildTaskFormData", () => {
  it("titre/statut/priorité toujours présents", () => {
    const fd = buildTaskFormData(values())
    assert.equal(fd.get("title"), "T")
    assert.equal(fd.get("status"), "TODO")
    assert.equal(fd.get("priority"), "MEDIUM")
  })
  it("champs facultatifs omis quand vides/absents", () => {
    const fd = buildTaskFormData(values({ description: "", dueDate: "", assigneeId: "", worksiteId: "" }))
    assert.equal(fd.has("description"), false)
    assert.equal(fd.has("dueDate"), false)
    assert.equal(fd.has("assigneeId"), false)
    assert.equal(fd.has("worksiteId"), false)
  })
  it("champs facultatifs transmis quand renseignés", () => {
    const fd = buildTaskFormData(
      values({ description: "détail", dueDate: "2026-03-15", assigneeId: "emp1", worksiteId: "ws1" })
    )
    assert.equal(fd.get("description"), "détail")
    assert.equal(fd.get("dueDate"), "2026-03-15")
    assert.equal(fd.get("assigneeId"), "emp1")
    assert.equal(fd.get("worksiteId"), "ws1")
  })
})

describe("submitTaskForm — succès", () => {
  it("{ success:true } → toast succès, reset et fermeture (onSuccess)", async () => {
    const rec = recorder({ success: true })
    await submitTaskForm(values(), rec.deps)
    assert.deepEqual(rec.success, [TASK_CREATED_MESSAGE])
    assert.deepEqual(rec.error, [])
    assert.equal(rec.resetCount(), 1)
    assert.equal(rec.successCloseCount(), 1)
    assert.equal(rec.sent.length, 1)
  })
  it("résultat void (succès implicite) → même comportement", async () => {
    const rec = recorder(undefined)
    await submitTaskForm(values(), rec.deps)
    assert.deepEqual(rec.success, [TASK_CREATED_MESSAGE])
    assert.equal(rec.resetCount(), 1)
    assert.equal(rec.successCloseCount(), 1)
  })
})

describe("submitTaskForm — erreur", () => {
  it("{ error } → toast erreur, ni reset ni fermeture", async () => {
    const rec = recorder({ error: "Accès refusé." })
    await submitTaskForm(values(), rec.deps)
    assert.deepEqual(rec.error, ["Accès refusé."])
    assert.deepEqual(rec.success, [])
    assert.equal(rec.resetCount(), 0)
    assert.equal(rec.successCloseCount(), 0)
  })
})
