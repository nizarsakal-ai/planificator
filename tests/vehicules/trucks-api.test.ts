import assert from "node:assert/strict"
import { beforeEach, describe, it } from "node:test"
import {
  classifyUniqueConflict,
  classifyVanishedReference,
  handleTruckDelete,
  handleTruckPatch,
  handleTrucksGet,
  handleTrucksPost,
  type TrucksApiDeps,
  type TrucksDb,
} from "@/lib/vehicules/trucks-api"

// ─── Base en mémoire (contraintes d'unicité, cascade, rollback de transaction) ─

interface TruckRow {
  id: string
  matricule: string
  marque: string | null
  companyId: string
  teamId: string | null
  chauffeurId: string | null
}
interface AssignmentRow {
  id: string
  truckId: string
  chauffeurId: string | null
  teamId: string | null
  companyId: string
  startedAt: Date
  endedAt: Date | null
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

class FakeDb {
  state: State
  calls: { op: string; args: unknown }[] = []
  failOn: string | null = null
  failWith: unknown = null
  private seq = 0

  constructor(state: State) {
    this.state = state
  }

  private hit(op: string, args: unknown) {
    this.calls.push({ op, args })
    if (this.failOn === op) throw this.failWith
  }

  private checkUnique(t: TruckRow) {
    if (this.state.trucks.some((o) => o.id !== t.id && o.companyId === t.companyId && o.matricule === t.matricule))
      throw p2002(["matricule", "companyId"])
    if (t.teamId && this.state.trucks.some((o) => o.id !== t.id && o.teamId === t.teamId)) throw p2002(["teamId"])
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
    create: async (args: { data: Omit<TruckRow, "id" | "teamId" | "chauffeurId"> }) => {
      this.hit("truck.create", args)
      const row: TruckRow = { id: `tr-new-${++this.seq}`, teamId: null, chauffeurId: null, ...args.data }
      this.checkUnique(row)
      this.state.trucks.push(row)
      return { ...row }
    },
    update: async (args: { where: { id: string }; data: Partial<TruckRow> }) => {
      this.hit("truck.update", args)
      const i = this.state.trucks.findIndex((t) => t.id === args.where.id)
      if (i < 0) throw Object.assign(new Error("not found"), { code: "P2025" })
      const next = { ...this.state.trucks[i], ...args.data }
      this.checkUnique(next)
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
      return t ? { id: t.id } : null
    },
  }

  employee = {
    findFirst: async (args: { where: Where }) => {
      this.hit("employee.findFirst", args)
      const e = this.state.employees.find((r) => matches(r as never, args.where))
      return e ? { id: e.id } : null
    },
  }

  truckAssignment = {
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
      const row: AssignmentRow = { id: `as-${++this.seq}`, endedAt: null, ...args.data }
      this.state.assignments.push(row)
      return { ...row }
    },
  }

  $transaction = async <T>(fn: (tx: FakeDb) => Promise<T>): Promise<T> => {
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
        const a = c.args as { where?: Where; data?: Record<string, unknown> }
        if (c.op === "truck.update" || c.op === "truckAssignment.updateMany") return false // ciblage par id déjà vérifié dans le tenant
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

function seed(): State {
  return {
    trucks: [
      { id: "tr-1", matricule: "AB-123-CD", marque: "Crafter", companyId: CO, teamId: "team-1", chauffeurId: "emp-1" },
      { id: "tr-2", matricule: "EF-456-GH", marque: null, companyId: CO, teamId: null, chauffeurId: null },
      { id: "tr-x", matricule: "ZZ-999-ZZ", marque: "Master", companyId: OTHER, teamId: "team-x", chauffeurId: "emp-x" },
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
    db.state.trucks.push({ id: "tr-long", matricule: "L".repeat(300), marque: "x".repeat(1000), companyId: CO, teamId: null, chauffeurId: null })
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
    const block = src.slice(src.indexOf("const matriculeSchema"), src.indexOf("const optionalIdSchema"))
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
    db.state.trucks.push({ id: "tr-sp", matricule: "QR-222-ST ", marque: null, companyId: CO, teamId: null, chauffeurId: null })
    const r = await patch("tr-sp", { marque: "Ducato" })
    assert.equal(r.status, 200)
    assert.equal(db.state.trucks.find((t) => t.id === "tr-sp")!.matricule, "QR-222-ST ")
    assert.equal((await patch("tr-sp", { teamId: "team-2" })).status, 200)
  })

  it("aucune collision nouvelle : les écrans envoyaient déjà l'immatriculation trimée", async () => {
    // Cas historique « AB-1 » et « AB-1 » (espace final) dans le même tenant.
    db.state.trucks.push(
      { id: "tr-e1", matricule: "UV-333-WX", marque: null, companyId: CO, teamId: null, chauffeurId: null },
      { id: "tr-e2", matricule: "UV-333-WX ", marque: null, companyId: CO, teamId: null, chauffeurId: null }
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
    ["DELETE", "truck.deleteMany", () => del("tr-2")],
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

  it("POST ne crée pas de ligne d'historique (comportement actuel conservé)", async () => {
    const before = db.state.assignments.length
    await post({ matricule: "HS-000-AA" })
    assert.equal(db.state.assignments.length, before)
  })

  it("DELETE (ADMIN) : suppression physique conservée, historique en cascade (comportement actuel)", async () => {
    await del("tr-1")
    assert.ok(!db.state.trucks.some((t) => t.id === "tr-1"))
    assert.equal(db.state.assignments.filter((a) => a.truckId === "tr-1").length, 0)
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
