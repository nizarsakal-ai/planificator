// Module Tâches V1 — Adaptateur Prisma : filtres réellement construits (mock, aucune DB).
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Role } from "@prisma/client"
import { createTaskCore } from "@/lib/actions/task-create.core"
import { buildPrismaTaskDeps, type TaskPrismaClient } from "@/lib/actions/task-create.prisma"

type Calls = {
  userFindUnique: unknown[]
  employeeFindFirst: unknown[]
  worksiteFindFirst: unknown[]
  taskCreate: unknown[]
  txOptions: unknown[]
}

function mockClient(opts: {
  account?: {
    id: string
    active: boolean
    role: Role
    companyId: string | null
    company: { active: boolean } | null
  } | null
  employee?: { id: string } | null
  worksite?: { id: string } | null
}): { client: TaskPrismaClient; calls: Calls } {
  const calls: Calls = {
    userFindUnique: [],
    employeeFindFirst: [],
    worksiteFindFirst: [],
    taskCreate: [],
    txOptions: [],
  }
  const employee = {
    findFirst: async (args: unknown) => {
      calls.employeeFindFirst.push(args)
      return opts.employee === undefined ? { id: "emp1" } : opts.employee
    },
  }
  const worksite = {
    findFirst: async (args: unknown) => {
      calls.worksiteFindFirst.push(args)
      return opts.worksite === undefined ? { id: "ws1" } : opts.worksite
    },
  }
  const task = {
    create: async (args: unknown) => {
      calls.taskCreate.push(args)
      return { id: "task-created" }
    },
  }
  const client = {
    user: {
      findUnique: async (args: unknown) => {
        calls.userFindUnique.push(args)
        return opts.account === undefined
          ? { id: "u1", active: true, role: "ADMIN" as Role, companyId: "co1", company: { active: true } }
          : opts.account
      },
    },
    employee,
    worksite,
    task,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>, options?: unknown) => {
      calls.txOptions.push(options)
      return fn({ employee, worksite, task })
    },
  } as unknown as TaskPrismaClient
  return { client, calls }
}

describe("buildPrismaTaskDeps — lecture du compte", () => {
  it("findUnique par id avec sélection minimale", async () => {
    const { client, calls } = mockClient({})
    const deps = buildPrismaTaskDeps(client, async () => ({ user: { id: "u1" } }), () => {})
    await createTaskCore({ title: "T" }, deps)
    assert.deepEqual(calls.userFindUnique[0], {
      where: { id: "u1" },
      select: {
        id: true,
        active: true,
        role: true,
        companyId: true,
        company: { select: { active: true } },
      },
    })
  })

  it("entreprise inactive → aucune insertion ni revalidation", async () => {
    let revalidated = 0
    const { client, calls } = mockClient({
      account: { id: "u1", active: true, role: "ADMIN" as Role, companyId: "co1", company: { active: false } },
    })
    const deps = buildPrismaTaskDeps(client, async () => ({ user: { id: "u1" } }), () => {
      revalidated += 1
    })
    const r = await createTaskCore({ title: "T" }, deps)
    assert.equal(r.ok, false)
    assert.equal(calls.taskCreate.length, 0)
    assert.equal(revalidated, 0)
  })
})

describe("buildPrismaTaskDeps — transaction & filtres tenant", () => {
  it("transaction Serializable, filtres employé/chantier et data exacts", async () => {
    const { client, calls } = mockClient({})
    const deps = buildPrismaTaskDeps(client, async () => ({ user: { id: "u1" } }), () => {})
    const r = await createTaskCore(
      {
        title: "Audit",
        description: "détail",
        status: "IN_PROGRESS",
        priority: "HIGH",
        dueDate: "2026-05-04",
        assigneeId: "emp1",
        worksiteId: "ws1",
      },
      deps
    )
    assert.equal(r.ok, true)

    // Isolation Serializable
    assert.deepEqual(calls.txOptions[0], { isolationLevel: "Serializable" })

    // Employé filtré par tenant + active:true, sélection minimale
    assert.deepEqual(calls.employeeFindFirst[0], {
      where: { id: "emp1", companyId: "co1", active: true },
      select: { id: true },
    })
    // Chantier filtré par tenant, sélection minimale
    assert.deepEqual(calls.worksiteFindFirst[0], {
      where: { id: "ws1", companyId: "co1" },
      select: { id: true },
    })

    // Données d'insertion : tenant/créateur imposés, select minimal
    const createArg = calls.taskCreate[0] as { data: Record<string, unknown>; select: unknown }
    assert.deepEqual(createArg.select, { id: true })
    assert.equal(createArg.data.companyId, "co1")
    assert.equal(createArg.data.createdById, "u1")
    assert.equal(createArg.data.title, "Audit")
    assert.equal(createArg.data.status, "IN_PROGRESS")
    assert.equal(createArg.data.priority, "HIGH")
    assert.equal((createArg.data.dueDate as Date).toISOString(), "2026-05-04T00:00:00.000Z")
    assert.equal(createArg.data.assigneeId, "emp1")
    assert.equal(createArg.data.worksiteId, "ws1")
  })

  it("le companyId du compte prime (jamais un companyId arbitraire)", async () => {
    const { client, calls } = mockClient({
      account: { id: "u9", active: true, role: "SUPER_ADMIN" as Role, companyId: "co-super", company: { active: true } },
    })
    const deps = buildPrismaTaskDeps(client, async () => ({ user: { id: "u9" } }), () => {})
    await createTaskCore({ title: "T", assigneeId: "emp1" }, deps)
    assert.deepEqual(calls.employeeFindFirst[0], {
      where: { id: "emp1", companyId: "co-super", active: true },
      select: { id: true },
    })
    const createArg = calls.taskCreate[0] as { data: Record<string, unknown> }
    assert.equal(createArg.data.companyId, "co-super")
    assert.equal(createArg.data.createdById, "u9")
  })

  it("référence cross-tenant (findFirst → null) → aucune insertion", async () => {
    const { client, calls } = mockClient({ employee: null })
    const deps = buildPrismaTaskDeps(client, async () => ({ user: { id: "u1" } }), () => {})
    const r = await createTaskCore({ title: "T", assigneeId: "emp-autre-tenant" }, deps)
    assert.equal(r.ok, false)
    assert.equal(calls.taskCreate.length, 0)
  })
})
