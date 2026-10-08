// Module Tâches V1 — Cœur de création : autorisation, isolation, références, transaction (aucune DB).
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Role } from "@prisma/client"
import {
  authorizeTaskCreation,
  createTaskCore,
  defaultIsSerializationConflict,
  EMPLOYEE_NOT_FOUND_MESSAGE,
  WORKSITE_NOT_FOUND_MESSAGE,
  type CreateTaskDeps,
  type TaskActor,
  type TaskCreateData,
  type TaskCreateTx,
} from "@/lib/actions/task-create.core"

function actor(over: Partial<TaskActor> = {}): TaskActor {
  return {
    id: "u1",
    active: true,
    role: "ADMIN" as Role,
    companyId: "co1",
    company: { active: true },
    ...over,
  }
}

type TxRecorder = {
  tx: TaskCreateTx
  created: TaskCreateData[]
  employeeQueries: { id: string; companyId: string }[]
  worksiteQueries: { id: string; companyId: string }[]
}

function recorder(opts: {
  employee?: { id: string } | null
  worksite?: { id: string } | null
} = {}): TxRecorder {
  const created: TaskCreateData[] = []
  const employeeQueries: { id: string; companyId: string }[] = []
  const worksiteQueries: { id: string; companyId: string }[] = []
  const employeeResult = opts.employee === undefined ? { id: "emp1" } : opts.employee
  const worksiteResult = opts.worksite === undefined ? { id: "ws1" } : opts.worksite
  return {
    created,
    employeeQueries,
    worksiteQueries,
    tx: {
      findEmployee: async (args) => {
        employeeQueries.push(args)
        return employeeResult
      },
      findWorksite: async (args) => {
        worksiteQueries.push(args)
        return worksiteResult
      },
      createTask: async (data) => {
        created.push(data)
        return { id: "task1" }
      },
    },
  }
}

function baseDeps(over: Partial<CreateTaskDeps> = {}): { deps: CreateTaskDeps; revalidated: () => number } {
  let revalidateCount = 0
  const rec = recorder()
  const deps: CreateTaskDeps = {
    auth: async () => ({ user: { id: "u1" } }),
    loadAccount: async () => actor(),
    runInTransaction: async (fn) => fn(rec.tx),
    revalidate: () => {
      revalidateCount += 1
    },
    ...over,
  }
  return { deps, revalidated: () => revalidateCount }
}

describe("authorizeTaskCreation", () => {
  it("ADMIN actif avec entreprise → autorisé", () => {
    assert.deepEqual(authorizeTaskCreation(actor()), { ok: true, companyId: "co1" })
  })
  it("SUPER_ADMIN avec entreprise → autorisé dans cette entreprise", () => {
    assert.deepEqual(
      authorizeTaskCreation(actor({ role: "SUPER_ADMIN" as Role, companyId: "coX" })),
      { ok: true, companyId: "coX" }
    )
  })
  it("SUPER_ADMIN sans entreprise → refusé", () => {
    assert.deepEqual(authorizeTaskCreation(actor({ role: "SUPER_ADMIN" as Role, companyId: null })), { ok: false })
  })
  for (const role of ["TEAM_LEADER", "EMPLOYEE", "CLIENT"] as Role[]) {
    it(`${role} → refusé`, () => {
      assert.deepEqual(authorizeTaskCreation(actor({ role })), { ok: false })
    })
  }
  it("compte inactif → refusé", () => {
    assert.deepEqual(authorizeTaskCreation(actor({ active: false })), { ok: false })
  })
  it("compte absent → refusé", () => {
    assert.deepEqual(authorizeTaskCreation(null), { ok: false })
  })
  it("ADMIN sans entreprise → refusé", () => {
    assert.deepEqual(authorizeTaskCreation(actor({ companyId: null })), { ok: false })
  })
  it("entreprise inactive → refusé", () => {
    assert.deepEqual(authorizeTaskCreation(actor({ company: { active: false } })), { ok: false })
  })
  it("relation entreprise absente (companyId orphelin) → refusé", () => {
    assert.deepEqual(authorizeTaskCreation(actor({ company: null })), { ok: false })
  })
})

describe("createTaskCore — autorisation", () => {
  it("session absente → FORBIDDEN, aucune lecture de compte", async () => {
    let loaded = false
    const { deps } = baseDeps({
      auth: async () => null,
      loadAccount: async () => {
        loaded = true
        return actor()
      },
    })
    const r = await createTaskCore({ title: "T" }, deps)
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "FORBIDDEN")
    assert.equal(loaded, false)
  })

  it("compte absent en base → FORBIDDEN", async () => {
    const { deps } = baseDeps({ loadAccount: async () => null })
    const r = await createTaskCore({ title: "T" }, deps)
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "FORBIDDEN")
  })

  it("rôle réel (base) différent de la session → la base fait foi", async () => {
    // La session prétend u1 ; la base renvoie EMPLOYEE → refusé.
    const { deps } = baseDeps({ loadAccount: async () => actor({ role: "EMPLOYEE" as Role }) })
    const r = await createTaskCore({ title: "T" }, deps)
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "FORBIDDEN")
  })

  it("compte inactif → FORBIDDEN", async () => {
    const { deps } = baseDeps({ loadAccount: async () => actor({ active: false }) })
    const r = await createTaskCore({ title: "T" }, deps)
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "FORBIDDEN")
  })

  it("entreprise absente → FORBIDDEN", async () => {
    const { deps } = baseDeps({ loadAccount: async () => actor({ companyId: null }) })
    const r = await createTaskCore({ title: "T" }, deps)
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "FORBIDDEN")
  })

  it("entreprise inactive → FORBIDDEN, aucune transaction ni revalidation", async () => {
    let txRan = false
    const { deps, revalidated } = baseDeps({
      loadAccount: async () => actor({ company: { active: false } }),
      runInTransaction: async (fn) => {
        txRan = true
        return fn(recorder().tx)
      },
    })
    const r = await createTaskCore({ title: "T" }, deps)
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "FORBIDDEN")
    assert.equal(txRan, false)
    assert.equal(revalidated(), 0)
  })
})

describe("createTaskCore — validation", () => {
  it("entrée invalide → INVALID, pas de transaction", async () => {
    let txRan = false
    const { deps } = baseDeps({
      runInTransaction: async (fn) => {
        txRan = true
        return fn(recorder().tx)
      },
    })
    const r = await createTaskCore({ title: "" }, deps)
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "INVALID")
    assert.equal(txRan, false)
  })
})

describe("createTaskCore — isolation tenant", () => {
  it("companyId et createdById imposés par le serveur, jamais par le payload", async () => {
    const rec = recorder()
    let revalidated = 0
    const deps: CreateTaskDeps = {
      auth: async () => ({ user: { id: "u-real" } }),
      loadAccount: async () => actor({ id: "u-real", companyId: "co-real" }),
      runInTransaction: async (fn) => fn(rec.tx),
      revalidate: () => {
        revalidated += 1
      },
    }
    // Le client tente d'injecter companyId/createdById → ignorés par le parseur et le cœur.
    const r = await createTaskCore(
      { title: "T", companyId: "co-attaquant", createdById: "u-attaquant" },
      deps
    )
    // Les champs réservés font échouer la validation (défense en profondeur).
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "INVALID")
    assert.equal(rec.created.length, 0)
    assert.equal(revalidated, 0)
  })

  it("companyId/createdById proviennent du compte vérifié", async () => {
    const rec = recorder()
    const deps: CreateTaskDeps = {
      auth: async () => ({ user: { id: "u-real" } }),
      loadAccount: async () => actor({ id: "u-real", companyId: "co-real" }),
      runInTransaction: async (fn) => fn(rec.tx),
      revalidate: () => {},
    }
    const r = await createTaskCore({ title: "T" }, deps)
    assert.equal(r.ok, true)
    assert.equal(rec.created[0].companyId, "co-real")
    assert.equal(rec.created[0].createdById, "u-real")
  })

  it("les vérifications de références utilisent le companyId du compte", async () => {
    const rec = recorder()
    const deps: CreateTaskDeps = {
      auth: async () => ({ user: { id: "u1" } }),
      loadAccount: async () => actor({ companyId: "co-tenant" }),
      runInTransaction: async (fn) => fn(rec.tx),
      revalidate: () => {},
    }
    await createTaskCore({ title: "T", assigneeId: "emp1", worksiteId: "ws1" }, deps)
    assert.deepEqual(rec.employeeQueries, [{ id: "emp1", companyId: "co-tenant" }])
    assert.deepEqual(rec.worksiteQueries, [{ id: "ws1", companyId: "co-tenant" }])
  })
})

describe("createTaskCore — références", () => {
  it("employé introuvable / cross-tenant → REFERENCE, aucune insertion", async () => {
    const rec = recorder({ employee: null })
    let revalidated = 0
    const deps: CreateTaskDeps = {
      ...baseDeps().deps,
      runInTransaction: async (fn) => fn(rec.tx),
      revalidate: () => {
        revalidated += 1
      },
    }
    const r = await createTaskCore({ title: "T", assigneeId: "empX" }, deps)
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.outcome, "REFERENCE")
      assert.equal(r.message, EMPLOYEE_NOT_FOUND_MESSAGE)
    }
    assert.equal(rec.created.length, 0)
    assert.equal(revalidated, 0)
  })

  it("chantier introuvable / cross-tenant → REFERENCE, aucune insertion", async () => {
    const rec = recorder({ worksite: null })
    const deps: CreateTaskDeps = { ...baseDeps().deps, runInTransaction: async (fn) => fn(rec.tx) }
    const r = await createTaskCore({ title: "T", worksiteId: "wsX" }, deps)
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.outcome, "REFERENCE")
      assert.equal(r.message, WORKSITE_NOT_FOUND_MESSAGE)
    }
    assert.equal(rec.created.length, 0)
  })

  it("employé vérifié avant chantier : employé KO → le chantier n'est pas interrogé", async () => {
    const rec = recorder({ employee: null })
    const deps: CreateTaskDeps = { ...baseDeps().deps, runInTransaction: async (fn) => fn(rec.tx) }
    await createTaskCore({ title: "T", assigneeId: "empX", worksiteId: "ws1" }, deps)
    assert.equal(rec.worksiteQueries.length, 0)
  })

  it("sans références → aucune requête de vérification", async () => {
    const rec = recorder()
    const deps: CreateTaskDeps = { ...baseDeps().deps, runInTransaction: async (fn) => fn(rec.tx) }
    await createTaskCore({ title: "T" }, deps)
    assert.equal(rec.employeeQueries.length, 0)
    assert.equal(rec.worksiteQueries.length, 0)
    assert.equal(rec.created.length, 1)
  })
})

describe("createTaskCore — nominal", () => {
  it("création minimale : defaults, timestamps non fournis", async () => {
    const rec = recorder()
    let count = 0
    const deps: CreateTaskDeps = {
      auth: async () => ({ user: { id: "u1" } }),
      loadAccount: async () => actor(),
      runInTransaction: async (fn) => fn(rec.tx),
      revalidate: () => {
        count += 1
      },
    }
    const r = await createTaskCore({ title: "  Tâche  " }, deps)
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.task.id, "task1")
    const data = rec.created[0]
    assert.equal(data.title, "Tâche")
    assert.equal(data.description, null)
    assert.equal(data.status, "TODO")
    assert.equal(data.priority, "MEDIUM")
    assert.equal(data.dueDate, null)
    assert.equal(data.assigneeId, null)
    assert.equal(data.worksiteId, null)
    assert.equal("id" in data, false)
    assert.equal("createdAt" in data, false)
    assert.equal("updatedAt" in data, false)
    assert.equal(count, 1)
  })

  it("création complète : données persistées exactes + date UTC", async () => {
    const rec = recorder()
    const deps: CreateTaskDeps = { ...baseDeps().deps, runInTransaction: async (fn) => fn(rec.tx) }
    const r = await createTaskCore(
      {
        title: "Audit",
        description: "Vérifier le site",
        status: "IN_PROGRESS",
        priority: "HIGH",
        dueDate: "2026-12-01",
        assigneeId: "emp1",
        worksiteId: "ws1",
      },
      deps
    )
    assert.equal(r.ok, true)
    const data = rec.created[0]
    assert.equal(data.description, "Vérifier le site")
    assert.equal(data.status, "IN_PROGRESS")
    assert.equal(data.priority, "HIGH")
    assert.equal(data.dueDate!.toISOString(), "2026-12-01T00:00:00.000Z")
    assert.equal(data.assigneeId, "emp1")
    assert.equal(data.worksiteId, "ws1")
  })
})

describe("createTaskCore — transaction & conflits", () => {
  it("vérifications et création dans la MÊME transaction", async () => {
    const order: string[] = []
    const tx: TaskCreateTx = {
      findEmployee: async () => {
        order.push("employee")
        return { id: "emp1" }
      },
      findWorksite: async () => {
        order.push("worksite")
        return { id: "ws1" }
      },
      createTask: async () => {
        order.push("create")
        return { id: "t1" }
      },
    }
    let entered = false
    const deps: CreateTaskDeps = {
      auth: async () => ({ user: { id: "u1" } }),
      loadAccount: async () => actor(),
      runInTransaction: async (fn) => {
        entered = true
        return fn(tx)
      },
      revalidate: () => {},
    }
    await createTaskCore({ title: "T", assigneeId: "emp1", worksiteId: "ws1" }, deps)
    assert.equal(entered, true)
    assert.deepEqual(order, ["employee", "worksite", "create"])
  })

  it("conflit de sérialisation (P2034) → CONFLICT, sans succès ni revalidation", async () => {
    let revalidated = 0
    const deps: CreateTaskDeps = {
      auth: async () => ({ user: { id: "u1" } }),
      loadAccount: async () => actor(),
      runInTransaction: async () => {
        throw { code: "P2034" }
      },
      revalidate: () => {
        revalidated += 1
      },
    }
    const r = await createTaskCore({ title: "T" }, deps)
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "CONFLICT")
    assert.equal(revalidated, 0)
  })

  it("erreur générique → ERROR, sans revalidation ni fuite", async () => {
    let revalidated = 0
    const deps: CreateTaskDeps = {
      auth: async () => ({ user: { id: "u1" } }),
      loadAccount: async () => actor(),
      runInTransaction: async () => {
        throw new Error("colonne secrète xyz")
      },
      revalidate: () => {
        revalidated += 1
      },
    }
    const r = await createTaskCore({ title: "T" }, deps)
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.outcome, "ERROR")
      assert.doesNotMatch(r.message, /secrète|colonne|xyz/)
    }
    assert.equal(revalidated, 0)
  })
})

describe("defaultIsSerializationConflict", () => {
  it("vrai uniquement pour P2034", () => {
    assert.equal(defaultIsSerializationConflict({ code: "P2034" }), true)
    assert.equal(defaultIsSerializationConflict({ code: "P2002" }), false)
    assert.equal(defaultIsSerializationConflict(new Error("x")), false)
    assert.equal(defaultIsSerializationConflict(null), false)
  })
})
