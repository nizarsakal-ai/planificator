import assert from "node:assert/strict"
import { beforeEach, describe, it } from "node:test"
import {
  classifyUniqueConflict,
  classifyVanishedReference,
  handleTruckArchive,
  handleTruckDelete,
  handleTruckRestore,
  handleTruckPatch,
  handleTrucksGet,
  handleTrucksPost,
  type TrucksApiDeps,
  type TrucksDb,
} from "@/lib/vehicules/trucks-api"

// ─── Base en mémoire (contraintes V1A, verrous, cascade, rollback de transaction) ─

interface TruckRow {
  id: string
  matricule: string
  marque: string | null
  modele?: string | null
  companyId: string
  teamId: string | null
  chauffeurId: string | null
  active: boolean
  archivedAt: Date | null
  createdAt: Date
}
interface AssignmentRow {
  id: string
  truckId: string
  chauffeurId: string | null
  teamId: string | null
  companyId: string
  startedAt: Date
  endedAt: Date | null
  reason?: string | null
}
interface State {
  trucks: TruckRow[]
  teams: { id: string; companyId: string; active: boolean }[]
  employees: { id: string; companyId: string; active: boolean }[]
  assignments: AssignmentRow[]
}

type Where = Record<string, unknown>

function matches(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && !(v instanceof Date) && "not" in (v as object)) return row[k] !== (v as { not: unknown }).not
    return row[k] === v
  })
}

const p2002 = (target: string[]) => Object.assign(new Error("Unique constraint failed"), { code: "P2002", meta: { target } })
const checkViolation = (name: string) => Object.assign(new Error(`check ${name}`), { code: "23514", name: "CheckViolation" })

class FakeDb {
  state: State
  calls: { op: string; args: unknown }[] = []
  failOn: string | null = null
  failWith: unknown = null
  /** Simule une écriture concurrente juste avant l'ouverture de la transaction. */
  beforeTransaction: ((state: State) => void) | null = null
  private seq = 0

  constructor(state: State) {
    this.state = state
  }

  private hit(op: string, args: unknown) {
    this.calls.push({ op, args })
    if (this.failOn === op) throw this.failWith
  }

  /** Contraintes réelles : unicités (matricule, équipe) + CHECK V1A sur trucks. */
  private checkTruck(t: TruckRow) {
    if (this.state.trucks.some((o) => o.id !== t.id && o.companyId === t.companyId && o.matricule === t.matricule))
      throw p2002(["matricule", "companyId"])
    if (t.teamId && this.state.trucks.some((o) => o.id !== t.id && o.teamId === t.teamId)) throw p2002(["teamId"])
    if (!t.active && (t.teamId || t.chauffeurId)) throw checkViolation("trucks_v1a_archived_unassigned_check")
    if (t.active !== (t.archivedAt === null)) throw checkViolation("archive consistency")
  }

  /** Index unique openForTruckId (trigger V1A) : au plus une période ouverte par véhicule. */
  private checkOpen(a: AssignmentRow) {
    if (a.endedAt === null && this.state.assignments.some((o) => o.id !== a.id && o.truckId === a.truckId && o.endedAt === null))
      throw p2002(["openForTruckId"])
  }

  /** Verrous : trucks FOR UPDATE (liste d'ids) ; teams / employees FOR SHARE (relecture de l'activité). */
  $queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?")
    this.hit("$queryRaw", { sql, values })
    if (/FROM "teams"/.test(sql) || /FROM "employees"/.test(sql)) {
      const [id, companyId] = values as [string, string]
      const rows = /FROM "teams"/.test(sql) ? this.state.teams : this.state.employees
      return rows.filter((r) => r.id === id && r.companyId === companyId).map((r) => ({ active: r.active }))
    }
    const [ids, companyId] = values as [string[], string]
    return this.state.trucks
      .filter((t) => ids.includes(t.id) && t.companyId === companyId)
      .map((t) => ({ id: t.id }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  truck = {
    findMany: async (args: { where: Where }) => {
      this.hit("truck.findMany", args)
      return this.state.trucks.filter((t) => matches(t as never, args.where)).sort((a, b) => a.matricule.localeCompare(b.matricule))
    },
    findFirst: async (args: { where: Where; select?: Record<string, boolean> }) => {
      this.hit("truck.findFirst", args)
      const t = this.state.trucks.find((r) => matches(r as never, args.where))
      return t ? { ...t } : null
    },
    create: async (args: { data: Pick<TruckRow, "matricule" | "marque" | "modele" | "companyId"> }) => {
      this.hit("truck.create", args)
      const row: TruckRow = {
        id: `tr-new-${++this.seq}`,
        teamId: null,
        chauffeurId: null,
        active: true,
        archivedAt: null,
        createdAt: new Date(),
        ...args.data,
      }
      this.checkTruck(row)
      this.state.trucks.push(row)
      return { ...row }
    },
    update: async (args: { where: { id: string }; data: Partial<TruckRow> }) => {
      this.hit("truck.update", args)
      const i = this.state.trucks.findIndex((t) => t.id === args.where.id)
      if (i < 0) throw Object.assign(new Error("not found"), { code: "P2025" })
      const next = { ...this.state.trucks[i], ...args.data }
      this.checkTruck(next)
      this.state.trucks[i] = next
      return { ...next }
    },
    deleteMany: async (args: { where: Where }) => {
      this.hit("truck.deleteMany", args)
      const del = this.state.trucks.filter((t) => matches(t as never, args.where)).map((t) => t.id)
      this.state.trucks = this.state.trucks.filter((t) => !del.includes(t.id))
      this.state.assignments = this.state.assignments.filter((a) => !del.includes(a.truckId)) // onDelete: Cascade
      return { count: del.length }
    },
  }

  team = {
    findFirst: async (args: { where: Where }) => {
      this.hit("team.findFirst", args)
      const t = this.state.teams.find((r) => matches(r as never, args.where))
      return t ? { id: t.id, active: t.active } : null
    },
  }

  employee = {
    findFirst: async (args: { where: Where }) => {
      this.hit("employee.findFirst", args)
      const e = this.state.employees.find((r) => matches(r as never, args.where))
      return e ? { id: e.id, active: e.active } : null
    },
  }

  truckAssignment = {
    findFirst: async (args: { where: Where }) => {
      this.hit("truckAssignment.findFirst", args)
      const a = this.state.assignments.find((r) => matches(r as never, args.where))
      return a ? { ...a } : null
    },
    update: async (args: { where: { id: string }; data: Partial<AssignmentRow> }) => {
      this.hit("truckAssignment.update", args)
      const a = this.state.assignments.find((r) => r.id === args.where.id)
      if (!a) throw Object.assign(new Error("not found"), { code: "P2025" })
      Object.assign(a, args.data)
      this.checkOpen(a)
      return { ...a }
    },
    updateMany: async (args: { where: Where; data: { endedAt: Date } }) => {
      this.hit("truckAssignment.updateMany", args)
      let count = 0
      for (const a of this.state.assignments) {
        if (matches(a as never, args.where)) {
          a.endedAt = args.data.endedAt
          count++
        }
      }
      return { count }
    },
    create: async (args: { data: Omit<AssignmentRow, "id" | "endedAt"> }) => {
      this.hit("truckAssignment.create", args)
      const row: AssignmentRow = { id: `as-${++this.seq}`, endedAt: null, reason: null, ...args.data }
      this.checkOpen(row)
      this.state.assignments.push(row)
      return { ...row }
    },
  }

  $transaction = async <T>(fn: (tx: FakeDb) => Promise<T>): Promise<T> => {
    this.beforeTransaction?.(this.state)
    const snapshot = structuredClone(this.state)
    try {
      return await fn(this)
    } catch (err) {
      this.state = snapshot
      throw err
    }
  }

  opsWithoutCompany(): string[] {
    return this.calls
      .filter((c) => {
        const a = c.args as { where?: Where; data?: Record<string, unknown>; values?: unknown[] }
        // Écritures ciblées par id, toujours après vérification / verrou dans le tenant.
        if (c.op === "truck.update" || c.op === "truckAssignment.updateMany" || c.op === "truckAssignment.update") return false
        if (c.op === "$queryRaw") return !(a.values && typeof a.values[1] === "string")
        if (c.op === "truck.create" || c.op === "truckAssignment.create") return !a.data?.companyId
        return !a.where || !("companyId" in a.where)
      })
      .map((c) => c.op)
  }
}

// ─── Données ─────────────────────────────────────────────────────────────────

const CO = "co-A"
const OTHER = "co-B"
const T0 = new Date("2026-01-01T08:00:00Z")

/** Véhicule actif (V1A : active = true, archivedAt = null par défaut). */
function truck(row: Pick<TruckRow, "id" | "matricule" | "marque" | "companyId" | "teamId" | "chauffeurId">): TruckRow {
  return { active: true, archivedAt: null, createdAt: T0, ...row }
}

function seed(): State {
  return {
    trucks: [
      truck({ id: "tr-1", matricule: "AB-123-CD", marque: "Crafter", companyId: CO, teamId: "team-1", chauffeurId: "emp-1" }),
      truck({ id: "tr-2", matricule: "EF-456-GH", marque: null, companyId: CO, teamId: null, chauffeurId: null }),
      truck({ id: "tr-x", matricule: "ZZ-999-ZZ", marque: "Master", companyId: OTHER, teamId: "team-x", chauffeurId: "emp-x" }),
    ],
    teams: [
      { id: "team-1", companyId: CO, active: true },
      { id: "team-2", companyId: CO, active: true },
      { id: "team-x", companyId: OTHER, active: true },
    ],
    employees: [
      { id: "emp-1", companyId: CO, active: true },
      { id: "emp-2", companyId: CO, active: true },
      { id: "emp-x", companyId: OTHER, active: true },
    ],
    assignments: [
      { id: "as-open-1", truckId: "tr-1", chauffeurId: "emp-1", teamId: "team-1", companyId: CO, startedAt: T0, endedAt: null },
      { id: "as-open-x", truckId: "tr-x", chauffeurId: "emp-x", teamId: "team-x", companyId: OTHER, startedAt: T0, endedAt: null },
    ],
  }
}

let db: FakeDb
let logged: { context: string; details: Record<string, string | undefined> }[]

beforeEach(() => {
  db = new FakeDb(seed())
  logged = []
})

const NO_COMPANY_KEY = Symbol("no companyId key")

const deps = (role: string | null, companyId: string | null | typeof NO_COMPANY_KEY = CO, user = true): TrucksApiDeps => ({
  auth: async () =>
    role === null
      ? null
      : !user
        ? {}
        : companyId === NO_COMPANY_KEY
          ? { user: { id: "u-1", role } }
          : { user: { id: "u-1", role, companyId } },
  db: db as unknown as TrucksDb,
  logError: (context, details) => logged.push({ context, details }),
})

const json = (body: unknown) =>
  new Request("http://localhost/api/trucks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })

async function call(res: Promise<Response>) {
  const r = await res
  const text = await r.text()
  return { status: r.status, body: text ? JSON.parse(text) : null, text }
}

type CompanyArg = string | null | typeof NO_COMPANY_KEY

const get = (role: string | null, companyId: CompanyArg = CO) => call(handleTrucksGet(deps(role, companyId)))
const post = (body: unknown, role: string | null = "ADMIN", companyId: CompanyArg = CO) =>
  call(handleTrucksPost(json(body), deps(role, companyId)))
const patch = (id: string, body: unknown, role = "ADMIN", companyId: CompanyArg = CO) =>
  call(handleTruckPatch(json(body), id, deps(role, companyId)))
const del = (id: string, role = "ADMIN", companyId: CompanyArg = CO) => call(handleTruckDelete(id, deps(role, companyId)))

const openRows = (truckId: string) => db.state.assignments.filter((a) => a.truckId === truckId && a.endedAt === null)

// ─── RBAC ────────────────────────────────────────────────────────────────────

describe("V0 — RBAC", () => {
  it("GET : SUPER_ADMIN / ADMIN / TEAM_LEADER autorisés ; EMPLOYEE / CLIENT interdits", async () => {
    for (const role of ["SUPER_ADMIN", "ADMIN", "TEAM_LEADER"]) assert.equal((await get(role)).status, 200, role)
    for (const role of ["EMPLOYEE", "CLIENT", "UNKNOWN"]) {
      const r = await get(role)
      assert.equal(r.status, 403, role)
      assert.equal(r.body.code, "FORBIDDEN")
    }
  })

  it("401 sans session ou sans utilisateur", async () => {
    assert.deepEqual((await get(null)).body, { error: "Non authentifié", code: "UNAUTHENTICATED" })
    assert.equal((await call(handleTrucksGet(deps("ADMIN", CO, false)))).status, 401)
    assert.equal((await post({ matricule: "X" }, null)).status, 401)
    assert.equal(db.calls.length, 0)
  })

  it("POST et PATCH : SUPER_ADMIN / ADMIN / TEAM_LEADER autorisés ; EMPLOYEE / CLIENT interdits", async () => {
    let n = 0
    for (const role of ["SUPER_ADMIN", "ADMIN", "TEAM_LEADER"]) {
      assert.equal((await post({ matricule: `NEW-${++n}` }, role)).status, 200, `POST ${role}`)
      assert.equal((await patch("tr-2", { marque: `M${n}` }, role)).status, 200, `PATCH ${role}`)
    }
    const callsBefore = db.calls.length
    for (const role of ["EMPLOYEE", "CLIENT"]) {
      assert.equal((await post({ matricule: "NOPE" }, role)).status, 403, `POST ${role}`)
      assert.equal((await patch("tr-2", { marque: "nope" }, role)).status, 403, `PATCH ${role}`)
    }
    assert.equal(db.calls.length, callsBefore, "aucun accès DB pour un rôle interdit")
  })

  it("TEAM_LEADER conserve temporairement l'accès à tout véhicule du tenant (pas de restriction d'équipe en V0)", async () => {
    const r = await patch("tr-1", { chauffeurId: "emp-2" }, "TEAM_LEADER")
    assert.equal(r.status, 200)
  })

  it("DELETE : SUPER_ADMIN / ADMIN uniquement", async () => {
    for (const role of ["TEAM_LEADER", "EMPLOYEE", "CLIENT"]) {
      const r = await del("tr-2", role)
      assert.equal(r.status, 403, role)
    }
    assert.ok(db.state.trucks.some((t) => t.id === "tr-2"))
    assert.equal((await del("tr-2", "SUPER_ADMIN")).status, 200)
    assert.equal((await del("tr-1", "ADMIN")).status, 200)
  })
})

// ─── companyId de session ────────────────────────────────────────────────────

describe("V0 — companyId obligatoire et issu de la session", () => {
  it("companyId null, vide ou absent → 403 NO_COMPANY, aucun accès DB", async () => {
    for (const companyId of [null, "", "   ", NO_COMPANY_KEY] as const) {
      for (const r of [
        await get("ADMIN", companyId),
        await post({ matricule: "X1" }, "ADMIN", companyId),
        await patch("tr-1", { marque: "x" }, "ADMIN", companyId),
        await del("tr-1", "ADMIN", companyId),
      ]) {
        assert.equal(r.status, 403)
        assert.equal(r.body.code, "NO_COMPANY")
      }
    }
    assert.equal(db.calls.length, 0)
  })

  it("un companyId fourni par le client est refusé (clé inconnue)", async () => {
    const r = await post({ matricule: "NEW-1", companyId: OTHER })
    assert.equal(r.status, 400)
    assert.equal(r.body.code, "INVALID_PAYLOAD")
    const r2 = await patch("tr-2", { companyId: OTHER })
    assert.equal(r2.status, 400)
    assert.ok(!db.state.trucks.some((t) => t.matricule === "NEW-1"))
  })

  it("création rattachée à l'entreprise de session", async () => {
    const r = await post({ matricule: "NEW-2" }, "ADMIN", OTHER)
    assert.equal(r.status, 200)
    assert.equal(r.body.companyId, OTHER)
  })
})

// ─── Isolation tenant ────────────────────────────────────────────────────────

describe("V0 — isolation tenant", () => {
  it("GET ne renvoie que les véhicules de l'entreprise", async () => {
    const r = await get("ADMIN")
    assert.deepEqual(r.body.map((t: TruckRow) => t.id), ["tr-1", "tr-2"])
  })

  it("PATCH / DELETE d'un véhicule d'une autre entreprise → 404, rien n'est modifié", async () => {
    const before = structuredClone(db.state)
    assert.equal((await patch("tr-x", { marque: "pirate" })).body.code, "TRUCK_NOT_FOUND")
    assert.equal((await del("tr-x")).body.code, "TRUCK_NOT_FOUND")
    assert.deepEqual(db.state, before)
  })

  it("équipe ou chauffeur d'une autre entreprise → 404 dédié, rien n'est modifié", async () => {
    const before = structuredClone(db.state)
    const t = await patch("tr-2", { teamId: "team-x" })
    assert.equal(t.status, 404)
    assert.equal(t.body.code, "TEAM_NOT_FOUND")
    const c = await patch("tr-2", { chauffeurId: "emp-x" })
    assert.equal(c.status, 404)
    assert.equal(c.body.code, "DRIVER_NOT_FOUND")
    const unknownTeam = await patch("tr-2", { teamId: "team-404" })
    assert.equal(unknownTeam.body.code, "TEAM_NOT_FOUND")
    assert.deepEqual(db.state, before)
  })

  it("toutes les lectures / créations portent le companyId de session", async () => {
    await get("ADMIN")
    await post({ matricule: "NEW-3" })
    await patch("tr-2", { teamId: "team-2", chauffeurId: "emp-2" })
    await del("tr-2")
    assert.deepEqual(db.opsWithoutCompany(), [])
    for (const c of db.calls) {
      const a = c.args as { where?: { companyId?: string }; data?: { companyId?: string } }
      const company = a.where?.companyId ?? a.data?.companyId
      if (company !== undefined) assert.equal(company, CO, c.op)
    }
  })
})

// ─── Validation ──────────────────────────────────────────────────────────────

describe("V0 — validation des payloads", () => {
  const invalidPost: [string, unknown][] = [
    ["JSON invalide", "{not json"],
    ["tableau", []],
    ["null", "null"],
    ["matricule absent", { marque: "x" }],
    ["matricule non textuel", { matricule: 123 }],
    ["matricule vide", { matricule: "   " }],
    ["marque non textuelle", { matricule: "OK-1", marque: 42 }],
    ["clé inconnue", { matricule: "OK-1", teamId: "team-1" }],
  ]
  for (const [label, body] of invalidPost) {
    it(`POST rejeté : ${label}`, async () => {
      const r = await post(body)
      assert.equal(r.status, 400)
      assert.ok(["INVALID_JSON", "INVALID_PAYLOAD"].includes(r.body.code))
      assert.notEqual(r.body.error, "Matricule déjà existant")
      assert.ok(!db.calls.some((c) => c.op === "truck.create"))
    })
  }

  const invalidPatch: [string, unknown][] = [
    ["JSON invalide", "{"],
    ["matricule vide", { matricule: "" }],
    ["matricule non textuel", { matricule: { a: 1 } }],
    ["teamId non textuel", { teamId: 12 }],
    ["chauffeurId booléen", { chauffeurId: true }],
    ["clé inconnue", { color: "red" }],
  ]
  for (const [label, body] of invalidPatch) {
    it(`PATCH rejeté : ${label}`, async () => {
      const before = structuredClone(db.state)
      const r = await patch("tr-1", body)
      assert.equal(r.status, 400)
      assert.deepEqual(db.state, before)
    })
  }

  it("le détail de validation est fourni sans données internes", async () => {
    const r = await post({ matricule: 123 })
    assert.ok(Array.isArray(r.body.issues))
    assert.match(r.body.issues.join(" "), /matricule/)
  })

  it("payloads réels des écrans existants acceptés (VehiculesView, TruckSelector)", async () => {
    assert.equal((await post({ matricule: "NW-001-AA", marque: "" })).status, 200) // TruckSelector : marque vide
    assert.equal((await post({ matricule: "NW-002-AA", marque: "VW Crafter" })).status, 200)
    assert.equal((await patch("tr-2", { matricule: "EF-456-GH", marque: "Master" })).status, 200)
    assert.equal((await patch("tr-2", { teamId: "team-2" })).status, 200)
    assert.equal((await patch("tr-2", { teamId: null })).status, 200)
    assert.equal((await patch("tr-2", { chauffeurId: "emp-2" })).status, 200)
    assert.equal((await patch("tr-2", { chauffeurId: null })).status, 200)
    assert.equal((await patch("tr-2", { chauffeurId: "" })).status, 200) // ancien comportement : "" → null
    assert.equal(db.state.trucks.find((t) => t.id === "tr-2")!.chauffeurId, null)
  })
})

// ─── Immatriculation et doublons ─────────────────────────────────────────────

describe("V0 — longueurs : aucune limite au-delà de la DB historique (colonnes TEXT)", () => {
  it("matricule et marque longs acceptés en création", async () => {
    const r = await post({ matricule: "a".repeat(500), marque: "M".repeat(5000) })
    assert.equal(r.status, 200)
    assert.equal(r.body.matricule, "A".repeat(500))
    assert.equal(r.body.marque.length, 5000)
  })

  it("véhicule existant à valeurs longues : l'édition renvoyée par les écrans reste acceptée", async () => {
    db.state.trucks.push(truck({ id: "tr-long", matricule: "L".repeat(300), marque: "x".repeat(1000), companyId: CO, teamId: null, chauffeurId: null }))
    const r = await patch("tr-long", { matricule: "L".repeat(300), marque: "x".repeat(1000) + " v2" })
    assert.equal(r.status, 200)
    assert.equal(r.body.marque.length, 1003)
  })

  it("matricule vide ou blanc rejeté ; mauvais types rejetés", async () => {
    for (const matricule of ["", "   ", "\t\n"]) assert.equal((await post({ matricule })).status, 400, JSON.stringify(matricule))
    for (const body of [{ matricule: 1 }, { matricule: null }, { matricule: ["A"] }, { matricule: "OK", marque: 5 }, { matricule: "OK", marque: {} }]) {
      assert.equal((await post(body)).body.code, "INVALID_PAYLOAD", JSON.stringify(body))
    }
    assert.equal((await patch("tr-1", { matricule: " " })).status, 400)
    assert.equal((await patch("tr-1", { marque: false })).status, 400)
  })

  it("le schéma de validation ne contient aucune longueur maximale pour matricule / marque", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("src/lib/vehicules/trucks-api.ts", "utf8")
    const block = src.slice(src.indexOf("const matriculeSchema"), src.indexOf("/**\n * Modèle (V1C)"))
    assert.doesNotMatch(block, /\.max\(/)
  })
})

describe("V0 — espaces en bordure", () => {
  it("trim conservé à la création et à la modification (comme le faisaient déjà les écrans)", async () => {
    assert.equal((await post({ matricule: "  mn-111-op  ", marque: "  Jumper " })).body.matricule, "MN-111-OP")
    const r = await patch("tr-2", { matricule: " ef-456-gh ", marque: "  " })
    assert.equal(r.body.matricule, "EF-456-GH")
    assert.equal(r.body.marque, null)
  })

  it("ligne historique avec espaces : une modification sans matricule ne touche pas l'immatriculation", async () => {
    db.state.trucks.push(truck({ id: "tr-sp", matricule: "QR-222-ST ", marque: null, companyId: CO, teamId: null, chauffeurId: null }))
    const r = await patch("tr-sp", { marque: "Ducato" })
    assert.equal(r.status, 200)
    assert.equal(db.state.trucks.find((t) => t.id === "tr-sp")!.matricule, "QR-222-ST ")
    assert.equal((await patch("tr-sp", { teamId: "team-2" })).status, 200)
  })

  it("aucune collision nouvelle : les écrans envoyaient déjà l'immatriculation trimée", async () => {
    // Cas historique « AB-1 » et « AB-1 » (espace final) dans le même tenant.
    db.state.trucks.push(
      truck({ id: "tr-e1", matricule: "UV-333-WX", marque: null, companyId: CO, teamId: null, chauffeurId: null }),
      truck({ id: "tr-e2", matricule: "UV-333-WX ", marque: null, companyId: CO, teamId: null, chauffeurId: null })
    )
    // VehiculesView / TruckSelector envoient `matricule.trim()` : la collision existait déjà avant V0
    // (même valeur envoyée au serveur) ; V0 la signale par un 409 explicite au lieu d'un faux message générique.
    const sent = "UV-333-WX ".trim()
    const r = await patch("tr-e2", { matricule: sent, marque: "Boxer" })
    assert.equal(r.status, 409)
    assert.equal(r.body.code, "MATRICULE_CONFLICT")
    assert.equal(db.state.trucks.find((t) => t.id === "tr-e2")!.matricule, "UV-333-WX ")
    // Les autres opérations sur ce véhicule restent possibles.
    assert.equal((await patch("tr-e2", { chauffeurId: "emp-2" })).status, 200)
  })

  it("la suppression des limites ne crée pas de collision : valeurs distinctes restent distinctes", async () => {
    assert.equal((await post({ matricule: "AB123CD" })).status, 200)
    assert.equal((await post({ matricule: "AB-123-CD-" + "X".repeat(100) })).status, 200)
    assert.equal(db.state.trucks.filter((t) => t.companyId === CO).length, 4)
  })
})

describe("V0 — immatriculation et unicité", () => {
  it("normalisation prudente conservée : espaces de bord + majuscules", async () => {
    const r = await post({ matricule: "  ij-321-kl ", marque: "  Trafic  " })
    assert.equal(r.body.matricule, "IJ-321-KL")
    assert.equal(r.body.marque, "Trafic")
  })

  it("vrai doublon (même tenant, casse différente) → 409 Matricule déjà existant", async () => {
    const r = await post({ matricule: "ab-123-cd" })
    assert.equal(r.status, 409)
    assert.deepEqual(r.body, { error: "Matricule déjà existant", code: "MATRICULE_CONFLICT" })
    const p = await patch("tr-2", { matricule: "AB-123-CD" })
    assert.equal(p.status, 409)
    assert.equal(p.body.code, "MATRICULE_CONFLICT")
  })

  it("pas de fusion AB-123-CD / AB123CD ; même matricule autorisé dans une autre entreprise", async () => {
    assert.equal((await post({ matricule: "AB123CD" })).status, 200)
    assert.equal((await post({ matricule: "AB-123-CD" }, "ADMIN", OTHER)).status, 200)
  })

  it("conflit d'unicité sur l'équipe (course) → 409 dédié, pas « Matricule déjà existant »", async () => {
    db.failOn = "truckAssignment.create"
    db.failWith = p2002(["teamId"])
    const r = await patch("tr-2", { teamId: "team-2" })
    assert.equal(r.status, 409)
    assert.equal(r.body.code, "TEAM_CONFLICT")
  })

  it("classification P2002 : cible tableau ou nom de contrainte ; autres erreurs non classées", () => {
    assert.equal(classifyUniqueConflict(p2002(["matricule", "companyId"])), "MATRICULE_CONFLICT")
    assert.equal(classifyUniqueConflict({ code: "P2002", meta: { target: "trucks_matricule_companyId_key" } }), "MATRICULE_CONFLICT")
    assert.equal(classifyUniqueConflict({ code: "P2002", meta: { target: "trucks_teamId_key" } }), "TEAM_CONFLICT")
    assert.equal(classifyUniqueConflict({ code: "P2002", meta: {} }), null)
    assert.equal(classifyUniqueConflict({ code: "P2025" }), null)
    assert.equal(classifyUniqueConflict(new Error("boom")), null)
  })
})

// ─── Introuvable et erreurs serveur ──────────────────────────────────────────

describe("V0 — véhicule inexistant et erreurs inattendues", () => {
  it("disparition concurrente pendant PATCH → 404 dédié (P2025 / P2003), pas 500", async () => {
    db.failOn = "truck.update"
    db.failWith = Object.assign(new Error("Record to update not found"), { code: "P2025" })
    assert.equal((await patch("tr-2", { marque: "x" })).body.code, "TRUCK_NOT_FOUND")
    db.failWith = Object.assign(new Error("Foreign key constraint failed"), { code: "P2003", meta: { field_name: "trucks_teamId_fkey (index)" } })
    assert.equal((await patch("tr-2", { teamId: "team-2" })).body.code, "TEAM_NOT_FOUND")
    db.failWith = Object.assign(new Error("Foreign key constraint failed"), { code: "P2003", meta: { field_name: "trucks_chauffeurId_fkey (index)" } })
    assert.equal((await patch("tr-2", { chauffeurId: "emp-2" })).body.code, "DRIVER_NOT_FOUND")
    assert.equal(classifyVanishedReference({ code: "P2003", meta: {} }), null)
    assert.equal(classifyVanishedReference(new Error("x")), null)
    assert.equal(logged.length, 0)
  })


  it("PATCH / DELETE d'un id inexistant → 404 TRUCK_NOT_FOUND", async () => {
    assert.deepEqual((await patch("tr-404", { marque: "x" })).body, { error: "Camion introuvable", code: "TRUCK_NOT_FOUND" })
    assert.equal((await del("tr-404")).status, 404)
  })

  for (const [label, op, run] of [
    ["GET", "truck.findMany", () => get("ADMIN")],
    ["POST", "truck.create", () => post({ matricule: "BOOM-1" })],
    ["PATCH", "truck.update", () => patch("tr-2", { marque: "boom" })],
    ["DELETE", "truck.update", () => del("tr-2")], // V1B : DELETE = archivage
  ] as const) {
    it(`${label} : erreur inattendue → 500 générique, sans détail interne`, async () => {
      db.failOn = op
      db.failWith = Object.assign(new Error("connect postgresql://user:s3cret@db/planif failed\n    at PrismaClient"), {
        name: "PrismaClientInitializationError",
        code: "P1001",
      })
      const r = await run()
      assert.equal(r.status, 500)
      assert.deepEqual(r.body, { error: "Erreur serveur", code: "SERVER_ERROR" })
      assert.doesNotMatch(r.text, /postgresql|s3cret|Prisma|at /)
      assert.equal(logged.length, 1)
      assert.deepEqual(logged[0].details, { name: "PrismaClientInitializationError", code: "P1001" })
      assert.doesNotMatch(JSON.stringify(logged), /s3cret|postgresql/)
    })
  }
})

// ─── TruckAssignment (comportement existant) ─────────────────────────────────

describe("V0 — historique TruckAssignment inchangé", () => {
  it("changement d'équipe : période courante close, nouvelle période (équipe + chauffeur)", async () => {
    await patch("tr-1", { teamId: "team-2" })
    const rows = db.state.assignments.filter((a) => a.truckId === "tr-1")
    assert.equal(rows.length, 2)
    assert.ok(rows[0].endedAt instanceof Date)
    assert.equal(openRows("tr-1").length, 1)
    assert.deepEqual(
      { teamId: openRows("tr-1")[0].teamId, chauffeurId: openRows("tr-1")[0].chauffeurId, companyId: openRows("tr-1")[0].companyId },
      { teamId: "team-2", chauffeurId: "emp-1", companyId: CO }
    )
    assert.equal(rows[0].endedAt!.getTime(), openRows("tr-1")[0].startedAt.getTime())
  })

  it("équipe déjà équipée : l'autre véhicule est libéré et son historique clos / rouvert sans équipe", async () => {
    await patch("tr-2", { teamId: "team-1" })
    const displaced = db.state.trucks.find((t) => t.id === "tr-1")!
    assert.equal(displaced.teamId, null)
    assert.equal(displaced.chauffeurId, "emp-1")
    assert.deepEqual(
      openRows("tr-1").map((a) => [a.teamId, a.chauffeurId]),
      [[null, "emp-1"]]
    )
    assert.ok(db.state.assignments.find((a) => a.id === "as-open-1")!.endedAt)
    assert.deepEqual(
      openRows("tr-2").map((a) => [a.teamId, a.chauffeurId]),
      [["team-1", null]]
    )
    assert.equal(db.state.trucks.find((t) => t.id === "tr-2")!.teamId, "team-1")
  })

  it("changement de chauffeur seul → nouvelle période ; désaffectation → période sans chauffeur", async () => {
    await patch("tr-1", { chauffeurId: "emp-2" })
    assert.deepEqual(openRows("tr-1").map((a) => [a.teamId, a.chauffeurId]), [["team-1", "emp-2"]])
    await patch("tr-1", { chauffeurId: null })
    assert.deepEqual(openRows("tr-1").map((a) => [a.teamId, a.chauffeurId]), [["team-1", null]])
    assert.equal(db.state.assignments.filter((a) => a.truckId === "tr-1").length, 3)
  })

  it("renommage ou même affectation → aucun mouvement d'historique", async () => {
    const before = db.state.assignments.length
    await patch("tr-1", { matricule: "AB-123-CE", marque: "Crafter L3" })
    await patch("tr-1", { teamId: "team-1", chauffeurId: "emp-1" })
    assert.equal(db.state.assignments.length, before)
    assert.equal(openRows("tr-1").length, 1)
  })

  it("échec en cours de transaction → rien n'est appliqué (rollback)", async () => {
    const before = structuredClone(db.state)
    db.failOn = "truckAssignment.create"
    db.failWith = new Error("boom")
    const r = await patch("tr-2", { teamId: "team-1" })
    assert.equal(r.status, 500)
    assert.deepEqual(db.state, before)
  })

  it("V1B : POST ouvre une période CREATED (sans équipe ni chauffeur)", async () => {
    const before = db.state.assignments.length
    const r = await post({ matricule: "HS-000-AA" })
    assert.equal(db.state.assignments.length, before + 1)
    assert.deepEqual(
      openRows(r.body.id).map((a) => [a.reason, a.teamId, a.chauffeurId]),
      [["CREATED", null, null]]
    )
  })

  it("V1B : DELETE (ADMIN) archive au lieu de supprimer — historique intégralement conservé", async () => {
    const historyBefore = db.state.assignments.filter((a) => a.truckId === "tr-1").length
    const r = await del("tr-1")
    assert.equal(r.status, 200)
    assert.equal(r.body.archived, true)
    const t = db.state.trucks.find((x) => x.id === "tr-1")!
    assert.deepEqual([t.active, t.teamId, t.chauffeurId], [false, null, null])
    assert.equal(db.state.assignments.filter((a) => a.truckId === "tr-1").length, historyBefore + 1)
    assert.equal(db.state.assignments.filter((a) => a.truckId === "tr-x").length, 1)
  })
})

// ─── Routes : simples adaptateurs ────────────────────────────────────────────

describe("V0 — routes Next.js", () => {
  it("les routes délèguent aux handlers sans logique propre ni companyId client", async () => {
    const { readFileSync } = await import("node:fs")
    const list = readFileSync("src/app/api/trucks/route.ts", "utf8")
    const item = readFileSync("src/app/api/trucks/[id]/route.ts", "utf8")
    assert.match(list, /handleTrucksGet\(\{ auth, db: prisma \}\)/)
    assert.match(list, /handleTrucksPost\(req, \{ auth, db: prisma \}\)/)
    assert.match(item, /handleTruckPatch\(req, \(await context\.params\)\.id, \{ auth, db: prisma \}\)/)
    assert.match(item, /handleTruckDelete\(\(await context\.params\)\.id, \{ auth, db: prisma \}\)/)
    for (const src of [list, item]) {
      assert.doesNotMatch(src, /companyId/)
      assert.doesNotMatch(src, /prisma\.truck/)
    }
  })
})

// ─── V1B : archivage, restauration, historique fiable ───────────────────────

const archive = (id: string, role = "ADMIN", companyId: string | null = CO) => call(handleTruckArchive(id, deps(role, companyId)))
const restore = (id: string, role = "ADMIN", companyId: string | null = CO) => call(handleTruckRestore(id, deps(role, companyId)))
const periodsOf = (truckId: string) =>
  db.state.assignments.filter((a) => a.truckId === truckId).sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())

/** État (équipe, chauffeur, raison) d'un véhicule à la date D, reconstruit depuis l'historique. */
function stateAt(truckId: string, at: Date) {
  const p = periodsOf(truckId).find((a) => a.startedAt.getTime() <= at.getTime() && (a.endedAt === null || at.getTime() < a.endedAt.getTime()))
  return p ? { teamId: p.teamId, chauffeurId: p.chauffeurId, reason: p.reason ?? null } : null
}

describe("V1B — archivage atomique", () => {
  it("désaffecte équipe + chauffeur, clôt la période ouverte, ouvre une période ARCHIVED, conserve l'historique", async () => {
    const r = await archive("tr-1")
    assert.equal(r.status, 200)
    assert.deepEqual([r.body.archived, r.body.alreadyArchived], [true, false])
    const t = db.state.trucks.find((x) => x.id === "tr-1")!
    assert.deepEqual([t.active, t.teamId, t.chauffeurId], [false, null, null])
    assert.ok(t.archivedAt instanceof Date)
    const periods = periodsOf("tr-1")
    assert.equal(periods.length, 2)
    assert.ok(periods[0].endedAt instanceof Date)
    assert.deepEqual([periods[0].teamId, periods[0].chauffeurId], ["team-1", "emp-1"]) // période historique intacte
    assert.deepEqual(openRows("tr-1").map((a) => [a.reason, a.teamId, a.chauffeurId]), [["ARCHIVED", null, null]])
  })

  it("double archivage idempotent : 200, aucune écriture", async () => {
    await archive("tr-1")
    const before = structuredClone(db.state)
    const r = await archive("tr-1")
    assert.equal(r.status, 200)
    assert.equal(r.body.alreadyArchived, true)
    assert.deepEqual(db.state, before)
  })

  it("DELETE = archivage (idempotent, même RBAC)", async () => {
    assert.equal((await del("tr-1")).body.archived, true)
    assert.equal((await del("tr-1")).body.alreadyArchived, true)
    assert.ok(db.state.trucks.some((t) => t.id === "tr-1"))
  })

  it("véhicule legacy sans période ouverte : archivage possible, une période ARCHIVED est créée", async () => {
    assert.equal(openRows("tr-2").length, 0)
    assert.equal((await archive("tr-2")).status, 200)
    assert.deepEqual(openRows("tr-2").map((a) => a.reason), ["ARCHIVED"])
  })
})

describe("V1B — restauration", () => {
  it("réactive sans réaffectation implicite ; période RESTORED ; idempotente", async () => {
    await archive("tr-1")
    const r = await restore("tr-1")
    assert.equal(r.status, 200)
    assert.equal(r.body.alreadyActive, false)
    const t = db.state.trucks.find((x) => x.id === "tr-1")!
    assert.deepEqual([t.active, t.archivedAt, t.teamId, t.chauffeurId], [true, null, null, null])
    assert.deepEqual(periodsOf("tr-1").map((a) => a.reason ?? null), [null, "ARCHIVED", "RESTORED"])
    const before = structuredClone(db.state)
    assert.equal((await restore("tr-1")).body.alreadyActive, true)
    assert.deepEqual(db.state, before)
  })

  it("après restauration, le véhicule peut être réaffecté (REASSIGNED)", async () => {
    await archive("tr-1")
    await restore("tr-1")
    assert.equal((await patch("tr-1", { teamId: "team-2" })).status, 200)
    assert.deepEqual(openRows("tr-1").map((a) => [a.reason, a.teamId]), [["REASSIGNED", "team-2"]])
  })
})

describe("V1B — RBAC et tenant archive / restore", () => {
  it("archive / restore : SUPER_ADMIN et ADMIN seulement", async () => {
    for (const role of ["TEAM_LEADER", "EMPLOYEE", "CLIENT"]) {
      assert.equal((await archive("tr-2", role)).status, 403, `archive ${role}`)
      assert.equal((await restore("tr-2", role)).status, 403, `restore ${role}`)
    }
    assert.equal((await archive("tr-2", "SUPER_ADMIN")).status, 200)
    assert.equal((await restore("tr-2", "SUPER_ADMIN")).status, 200)
  })

  it("véhicule d'une autre entreprise ou inexistant → 404, rien n'est modifié ; companyId absent → 403", async () => {
    const before = structuredClone(db.state)
    assert.equal((await archive("tr-x")).body.code, "TRUCK_NOT_FOUND")
    assert.equal((await restore("tr-x")).body.code, "TRUCK_NOT_FOUND")
    assert.equal((await archive("tr-404")).status, 404)
    assert.equal((await archive("tr-1", "ADMIN", null)).body.code, "NO_COMPANY")
    assert.deepEqual(db.state, before)
  })
})

describe("V1B — historique fiable (raisons, chronologie, verrous)", () => {
  it("POST : période CREATED ; doublon d'un véhicule archivé → 409 TRUCK_ARCHIVED_EXISTS", async () => {
    await archive("tr-2")
    const r = await post({ matricule: "ef-456-gh" })
    assert.equal(r.status, 409)
    assert.equal(r.body.code, "TRUCK_ARCHIVED_EXISTS")
    assert.equal((await post({ matricule: "AB-123-CD" })).body.code, "MATRICULE_CONFLICT") // doublon d'un actif
  })

  it("changement d'équipe → REASSIGNED ; équipe déjà équipée → DISPLACED pour l'autre véhicule", async () => {
    await patch("tr-2", { teamId: "team-1" })
    assert.deepEqual(openRows("tr-2").map((a) => [a.reason, a.teamId]), [["REASSIGNED", "team-1"]])
    assert.deepEqual(openRows("tr-1").map((a) => [a.reason, a.teamId, a.chauffeurId]), [["DISPLACED", null, "emp-1"]])
  })

  it("équipe archivée, chauffeur inactif, véhicule archivé : nouvelles affectations refusées (409), rien n'est écrit", async () => {
    db.state.teams.push({ id: "team-old", companyId: CO, active: false })
    db.state.employees.push({ id: "emp-old", companyId: CO, active: false })
    const before = structuredClone(db.state)
    assert.equal((await patch("tr-2", { teamId: "team-old" })).body.code, "TEAM_INACTIVE")
    assert.equal((await patch("tr-2", { chauffeurId: "emp-old" })).body.code, "DRIVER_INACTIVE")
    assert.deepEqual(db.state, before)
    await archive("tr-2")
    const archivedState = structuredClone(db.state)
    assert.equal((await patch("tr-2", { teamId: "team-2" })).body.code, "TRUCK_ARCHIVED")
    assert.equal((await patch("tr-2", { chauffeurId: "emp-2" })).body.code, "TRUCK_ARCHIVED")
    assert.deepEqual(db.state, archivedState)
  })

  it("relations legacy inactives : jamais réécrites, valeur inchangée acceptée, renommage possible", async () => {
    db.state.employees.find((e) => e.id === "emp-1")!.active = false // chauffeur devenu inactif (cas staging/prod)
    const r = await patch("tr-1", { chauffeurId: "emp-1", teamId: "team-1", marque: "Crafter L3" })
    assert.equal(r.status, 200)
    const t = db.state.trucks.find((x) => x.id === "tr-1")!
    assert.deepEqual([t.chauffeurId, t.teamId, t.marque], ["emp-1", "team-1", "Crafter L3"])
    assert.deepEqual(periodsOf("tr-1").map((a) => a.id), ["as-open-1"]) // aucun mouvement d'historique
  })

  it("chronologie : une période n'est jamais close avant son début (horloge applicative en retard)", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000)
    db.state.assignments.find((a) => a.id === "as-open-1")!.startedAt = future
    await patch("tr-1", { chauffeurId: "emp-2" })
    for (const a of periodsOf("tr-1")) if (a.endedAt) assert.ok(a.endedAt.getTime() >= a.startedAt.getTime(), a.id)
    assert.equal(openRows("tr-1")[0].startedAt.getTime(), future.getTime())
  })

  it("verrou : véhicule cible et véhicule déplacé verrouillés dans l'ordre des ids, dans le tenant", async () => {
    await patch("tr-2", { teamId: "team-1" })
    const lock = db.calls.find((c) => c.op === "$queryRaw" && /FROM "trucks"/.test((c.args as { sql: string }).sql))!.args as {
      sql: string
      values: unknown[]
    }
    assert.match(lock.sql, /FOR UPDATE/)
    assert.deepEqual(lock.values, [["tr-1", "tr-2"], CO])
  })

  it("concurrence : équipe prise par un autre véhicule après la lecture → 409 CONCURRENT_UPDATE, rien n'est écrit", async () => {
    db.beforeTransaction = (state) => {
      // Entre la lecture préalable et la transaction, un autre véhicule prend team-2.
      const other = state.trucks.find((t) => t.id === "tr-1")!
      if (other.teamId === "team-1") other.teamId = "team-2"
    }
    const before = structuredClone(db.state)
    before.trucks.find((t) => t.id === "tr-1")!.teamId = "team-2"
    const r = await patch("tr-2", { teamId: "team-2" })
    assert.equal(r.status, 409)
    assert.equal(r.body.code, "CONCURRENT_UPDATE")
    assert.deepEqual(db.state, before)
  })

  it("activité relue sous verrou : équipe archivée / chauffeur désactivé juste avant la transaction → refus", async () => {
    db.beforeTransaction = (state) => {
      state.teams.find((t) => t.id === "team-2")!.active = false
      state.employees.find((e) => e.id === "emp-2")!.active = false
    }
    assert.equal((await patch("tr-2", { teamId: "team-2" })).body.code, "TEAM_INACTIVE")
    assert.equal((await patch("tr-2", { chauffeurId: "emp-2" })).body.code, "DRIVER_INACTIVE")
    const shares = db.calls.filter((c) => c.op === "$queryRaw" && /FOR SHARE/.test((c.args as { sql: string }).sql))
    assert.equal(shares.length, 2)
    assert.equal(openRows("tr-2").length, 0) // rien n'a été écrit
  })

  it("transaction expirée (P2028) ou interblocage PostgreSQL (40P01) → 409 CONCURRENT_UPDATE", async () => {
    for (const failWith of [
      Object.assign(new Error("Transaction already closed"), { code: "P2028" }),
      Object.assign(new Error("deadlock detected"), { code: "P2010", meta: { code: "40P01" } }),
    ]) {
      db.failOn = "$queryRaw"
      db.failWith = failWith
      const r = await patch("tr-2", { teamId: "team-2" })
      assert.equal(r.status, 409)
      assert.equal(r.body.code, "CONCURRENT_UPDATE")
    }
    assert.equal(logged.length, 0)
  })

  it("conflit sur la période ouverte (index openForTruckId) → 409 PERIOD_CONFLICT, jamais 500", async () => {
    db.failOn = "truckAssignment.create"
    db.failWith = p2002(["openForTruckId"])
    const r = await patch("tr-2", { teamId: "team-2" })
    assert.equal(r.status, 409)
    assert.equal(r.body.code, "PERIOD_CONFLICT")
    assert.equal(classifyUniqueConflict({ code: "P2002", meta: { target: "truck_assignments_openForTruckId_key" } }), "PERIOD_CONFLICT")
  })

  it("au plus une période ouverte par véhicule après toute séquence d'opérations", async () => {
    await patch("tr-2", { teamId: "team-1" })
    await patch("tr-1", { teamId: "team-2", chauffeurId: "emp-2" })
    await archive("tr-2")
    await restore("tr-2")
    await patch("tr-2", { teamId: "team-1" })
    for (const id of ["tr-1", "tr-2"]) assert.ok(openRows(id).length <= 1, id)
    for (const t of db.state.trucks.filter((x) => x.active && x.companyId === CO)) {
      const open = openRows(t.id)[0]
      assert.deepEqual([open.teamId, open.chauffeurId], [t.teamId, t.chauffeurId], t.id) // état courant = période ouverte
    }
  })

  it("reconstruction : à une date donnée, le véhicule avait telle équipe et tel chauffeur", async () => {
    const t1 = new Date()
    await new Promise((r) => setTimeout(r, 5))
    await patch("tr-1", { teamId: "team-2" })
    const t2 = new Date()
    await new Promise((r) => setTimeout(r, 5))
    await archive("tr-1")
    assert.deepEqual(stateAt("tr-1", t1), { teamId: "team-1", chauffeurId: "emp-1", reason: null })
    assert.deepEqual(stateAt("tr-1", t2), { teamId: "team-2", chauffeurId: "emp-1", reason: "REASSIGNED" })
    assert.deepEqual(stateAt("tr-1", new Date(Date.now() + 1000)), { teamId: null, chauffeurId: null, reason: "ARCHIVED" })
  })
})

describe("V1B — routes archive / restore", () => {
  it("routes POST dédiées : simples adaptateurs, sans companyId client", async () => {
    const { readFileSync } = await import("node:fs")
    const a = readFileSync("src/app/api/trucks/[id]/archive/route.ts", "utf8")
    const r = readFileSync("src/app/api/trucks/[id]/restore/route.ts", "utf8")
    assert.match(a, /export async function POST[\s\S]*handleTruckArchive\(\(await context\.params\)\.id, \{ auth, db: prisma \}\)/)
    assert.match(r, /export async function POST[\s\S]*handleTruckRestore\(\(await context\.params\)\.id, \{ auth, db: prisma \}\)/)
    for (const src of [a, r]) assert.doesNotMatch(src, /companyId|prisma\.truck/)
  })
})

describe("V1B — adaptation UI existante (garde-fous statiques)", () => {
  it("/equipes ne propose que les véhicules actifs ; VehiculesView archive / restaure sans DELETE ; TruckSelector remonte les erreurs", async () => {
    const { readFileSync } = await import("node:fs")
    const equipes = readFileSync("src/app/(dashboard)/equipes/page.tsx", "utf8")
    assert.match(equipes, /prisma\.truck\.findMany\(\{\s*where: \{ companyId, active: true \}/)
    const view = readFileSync("src/components/vehicules/VehiculesView.tsx", "utf8")
    assert.doesNotMatch(view, /method: "DELETE"/)
    assert.match(view, /\/api\/trucks\/\$\{t\.id\}\/\$\{archive \? "archive" : "restore"\}/)
    assert.match(readFileSync("src/lib/vehicules/vehicules-view.ts", "utf8"), /archived: "Archivés"/)
    const selector = readFileSync("src/components/equipes/TruckSelector.tsx", "utf8")
    assert.match(selector, /reportFailure\(await patchTruck\(/)
    assert.match(selector, /if \(await assign\(truck\.id\)\) toast\.success\("Camion ajouté"\)/)
    const card = readFileSync("src/components/vehicules/VehiculeCard.tsx", "utf8")
    assert.match(card, /\(inactif\)/)
    assert.match(card, /\(archivée\)/)
    const menu = readFileSync("src/components/equipes/EquipeActionsMenu.tsx", "utf8")
    assert.match(menu, /\.filter\(\(m\) => m\.active \|\| m\.id ===/)
  })
})

// ─── V1C — identité : modèle ─────────────────────────────────────────────────

describe("V1C — modele (identité véhicule)", () => {
  const row = (id: string) => db.state.trucks.find((t) => t.id === id)!

  it("POST : modele enregistré, trimé ; marque inchangée", async () => {
    const r = await post({ matricule: "V1C-001", marque: "Volkswagen", modele: "  Crafter  " })
    assert.equal(r.status, 200)
    assert.equal(r.body.marque, "Volkswagen")
    assert.equal(r.body.modele, "Crafter")
  })

  it("POST : modele absent, vide ou blanc → null ; payloads historiques (sans modele) toujours acceptés", async () => {
    assert.equal((await post({ matricule: "V1C-002", marque: "VW Crafter" })).body.modele, null)
    assert.equal((await post({ matricule: "V1C-003", modele: "" })).body.modele, null)
    assert.equal((await post({ matricule: "V1C-004", modele: "   " })).body.modele, null)
    assert.equal((await post({ matricule: "V1C-005", modele: null })).body.modele, null)
  })

  it("aucune transformation de casse (modele) ; matricule toujours en majuscules", async () => {
    const r = await post({ matricule: "v1c-006", modele: "Crafter l3H2" })
    assert.equal(r.body.modele, "Crafter l3H2")
    assert.equal(r.body.matricule, "V1C-006")
  })

  it("PATCH : modification de modele, puis effacement (vide → null) ; marque jamais touchée", async () => {
    assert.equal((await patch("tr-1", { modele: " L3H2 " })).status, 200)
    assert.equal(row("tr-1").modele, "L3H2")
    assert.equal(row("tr-1").marque, "Crafter")
    assert.equal((await patch("tr-1", { modele: "" })).status, 200)
    assert.equal(row("tr-1").modele, null)
    assert.equal(row("tr-1").marque, "Crafter")
  })

  it("PATCH sans modele : la valeur existante n'est pas réécrite", async () => {
    await patch("tr-1", { modele: "Crafter" })
    await patch("tr-1", { marque: "Volkswagen" })
    assert.equal(row("tr-1").modele, "Crafter")
  })

  it("longueur : 100 caractères acceptés, 101 → 400 (POST et PATCH), rien n'est écrit", async () => {
    assert.equal((await post({ matricule: "V1C-100", modele: "m".repeat(100) })).status, 200)
    const trucksBefore = db.state.trucks.length
    const p = await post({ matricule: "V1C-101", modele: "m".repeat(101) })
    assert.equal(p.status, 400)
    assert.equal(p.body.code, "INVALID_PAYLOAD")
    const u = await patch("tr-1", { modele: "m".repeat(101) })
    assert.equal(u.status, 400)
    assert.equal(db.state.trucks.length, trucksBefore)
    assert.equal(row("tr-1").modele ?? null, null)
  })

  it("le trim précède la limite : 100 caractères entourés d'espaces acceptés", async () => {
    assert.equal((await post({ matricule: "V1C-TRIM", modele: ` ${"m".repeat(100)} ` })).status, 200)
  })

  it("types invalides et clés inconnues toujours refusés (strict)", async () => {
    assert.equal((await post({ matricule: "V1C-T1", modele: 42 })).status, 400)
    assert.equal((await patch("tr-1", { modele: ["x"] })).status, 400)
    assert.equal((await post({ matricule: "V1C-T2", model: "Crafter" })).status, 400)
    assert.equal((await patch("tr-1", { companyId: "x", modele: "A" })).status, 400)
  })

  it("modification d'identité seule (matricule / marque / modele) : aucune nouvelle période", async () => {
    const before = db.state.assignments.length
    assert.equal((await patch("tr-1", { matricule: "AB-123-CF", marque: "Volkswagen", modele: "Crafter" })).status, 200)
    assert.equal(db.state.assignments.length, before)
    assert.equal(openRows("tr-1").length, 1)
    assert.equal((await patch("tr-2", { modele: "Master" })).status, 200)
    assert.equal(db.state.assignments.length, before)
  })

  it("modele ne contourne ni RBAC, ni tenant", async () => {
    assert.equal((await patch("tr-1", { modele: "X" }, "EMPLOYEE")).status, 403)
    assert.equal((await post({ matricule: "V1C-RB", modele: "X" }, "CLIENT")).status, 403)
    assert.equal((await patch("tr-x", { modele: "Hack" })).status, 404)
    assert.equal(row("tr-x").modele ?? null, null)
  })

  it("véhicule archivé : modele modifiable (identité) sans réaffectation ; période inchangée", async () => {
    await del("tr-1")
    const before = db.state.assignments.length
    assert.equal((await patch("tr-1", { modele: "Crafter" })).status, 200)
    assert.equal(db.state.assignments.length, before)
    assert.equal(row("tr-1").active, false)
    assert.equal(row("tr-1").teamId, null)
  })

  it("payloads des écrans V1C (Véhicules, TruckSelector) acceptés", async () => {
    assert.equal((await post({ matricule: "V1C-UI", marque: "", modele: "" })).status, 200)
    assert.equal((await patch("tr-2", { matricule: "EF-456-GH", marque: "Renault", modele: "Master" })).status, 200)
  })
})
