/**
 * Double transactionnel uniquement : clone/rollback et file série déterministe.
 * Il n'émule ni MVCC ni les triggers/FK PostgreSQL et ne prouve aucun verrou réel.
 */
import type { Prisma } from "@prisma/client"
import type { MileageEntryRecord } from "@/lib/vehicules/mileage-domain"
import type { MileageServiceDeps } from "@/lib/vehicules/mileage-service"
import type { MileageSession } from "@/lib/vehicules/mileage-access"

type Row = Record<string, unknown>
type Args = { where?: Row; data?: Row; select?: Row; orderBy?: Row }
export type StoredEntry = MileageEntryRecord & {
  recordedAt: Date
  createdById: string
  createdByNameSnapshot: string
  idempotencyKey: string
  requestHash: string
}
export interface StoredTrip {
  id: string
  companyId: string
  truckId: string
  startEntryId: string
  endEntryId: string | null
  worksiteId: string | null
  worksiteNameSnapshot: string | null
  teamId: string | null
  teamNameSnapshot: string | null
  chauffeurId: string | null
  chauffeurNameSnapshot: string | null
}
export interface StoredTruck {
  id: string
  companyId: string
  matricule: string
  marque: string | null
  modele: string | null
  active: boolean
  archivedAt: Date | null
  teamId: string | null
  chauffeurId: string | null
  currentMileage: number | null
  currentMileageEntryId: string | null
  mileageRevision: number
  createdAt: Date
}
export interface MileageMemoryState {
  trucks: StoredTruck[]
  users: { id: string; role: string; companyId: string | null; active: boolean; name: string | null }[]
  employees: { id: string; userId: string; companyId: string; active: boolean; firstName: string; lastName: string }[]
  teams: { id: string; companyId: string; leaderId: string; active: boolean; name: string }[]
  worksites: { id: string; companyId: string; name: string }[]
  entries: StoredEntry[]
  trips: StoredTrip[]
}

export const COMPANY = "company-a"
export const TRUCK = "truck-a"
export const SERVER_NOW = new Date("2026-10-08T12:00:00.000Z")
export const ADMIN: MileageSession = { user: { id: "admin-a", role: "ADMIN", companyId: COMPANY } }
export const LEADER: MileageSession = { user: { id: "leader-a", role: "TEAM_LEADER", companyId: COMPANY } }
export const NEXT_LEADER: MileageSession = { user: { id: "leader-b", role: "TEAM_LEADER", companyId: COMPANY } }
export const SUPER_ADMIN: MileageSession = { user: { id: "super", role: "SUPER_ADMIN", companyId: COMPANY } }

export function initialMileageState(): MileageMemoryState {
  const truck: StoredTruck = {
    id: TRUCK, companyId: COMPANY, matricule: "AB-123-CD", marque: "Renault", modele: "Master",
    active: true, archivedAt: null, teamId: "team-a", chauffeurId: "driver-a",
    currentMileage: null, currentMileageEntryId: null, mileageRevision: 0, createdAt: SERVER_NOW,
  }
  return {
    trucks: [truck, { ...truck, id: "truck-b", companyId: "company-b", teamId: null, chauffeurId: null }],
    users: [
      { id: "admin-a", role: "ADMIN", companyId: COMPANY, active: true, name: "Admin A" },
      { id: "admin-b", role: "ADMIN", companyId: "company-b", active: true, name: "Admin B" },
      { id: "leader-a", role: "TEAM_LEADER", companyId: COMPANY, active: true, name: "Leader A" },
      { id: "leader-b", role: "TEAM_LEADER", companyId: COMPANY, active: true, name: "Leader B" },
      { id: "super", role: "SUPER_ADMIN", companyId: null, active: true, name: "Super Admin" },
      { id: "employee", role: "EMPLOYEE", companyId: COMPANY, active: true, name: "Employee" },
      { id: "client", role: "CLIENT", companyId: COMPANY, active: true, name: "Client" },
    ],
    employees: [
      { id: "employee-a", userId: "leader-a", companyId: COMPANY, active: true, firstName: "Alice", lastName: "Leader" },
      { id: "employee-b", userId: "leader-b", companyId: COMPANY, active: true, firstName: "Bob", lastName: "Leader" },
      { id: "driver-a", userId: "employee", companyId: COMPANY, active: true, firstName: "Driver", lastName: "Initial" },
      { id: "driver-b", userId: "foreign-driver", companyId: "company-b", active: true, firstName: "Foreign", lastName: "Driver" },
    ],
    teams: [
      { id: "team-a", companyId: COMPANY, leaderId: "employee-a", active: true, name: "Équipe initiale" },
      { id: "team-b", companyId: COMPANY, leaderId: "employee-b", active: true, name: "Nouvelle équipe" },
      { id: "foreign-team", companyId: "company-b", leaderId: "driver-b", active: true, name: "Autre société" },
    ],
    worksites: [
      { id: "worksite-a", companyId: COMPANY, name: "Chantier initial" },
      { id: "worksite-b", companyId: "company-b", name: "Chantier autre société" },
    ],
    entries: [], trips: [],
  }
}

function matches(record: object, where: Row = {}): boolean {
  const row = record as Row
  return Object.entries(where).every(([key, value]) => row[key] === value)
}

export class MileageMemoryDb {
  state = initialMileageState()
  now = SERVER_NOW
  calls: { operation: string; args: unknown }[] = []
  failOnce: { operation: string; error: unknown } | null = null
  zeroOnce: string | null = null
  private queue = Promise.resolve()
  private sequence = 0

  deps(session: MileageSession | null = ADMIN): MileageServiceDeps {
    return { auth: async () => session, db: this as unknown as MileageServiceDeps["db"] }
  }

  private hit(operation: string, args: unknown) {
    this.calls.push({ operation, args: structuredClone(args) })
    if (this.failOnce?.operation === operation) {
      const error = this.failOnce.error
      this.failOnce = null
      throw error
    }
  }

  private tx(state: MileageMemoryState) {
    const find = <T extends object>(rows: T[], operation: string, args: Args): T | null => {
      this.hit(operation, args)
      const row = rows.find((item) => matches(item, args.where))
      return row ? structuredClone(row) : null
    }
    const many = <T extends object>(rows: T[], operation: string, args: Args): T[] => {
      this.hit(operation, args)
      const result = structuredClone(rows.filter((item) => matches(item, args.where)))
      if (args.orderBy?.revision === "asc") result.sort((a, b) => Number((a as Row).revision) - Number((b as Row).revision))
      return result
    }
    const update = <T extends object>(rows: T[], operation: string, args: Args) => {
      this.hit(operation, args)
      if (this.zeroOnce === operation) { this.zeroOnce = null; return { count: 0 } }
      const found = rows.filter((row) => matches(row, args.where))
      for (const row of found) Object.assign(row, structuredClone(args.data))
      return { count: found.length }
    }
    return {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?").replace(/\s+/g, " ").trim()
        this.hit("$queryRaw", { sql, values })
        if (sql.includes("clock_timestamp()")) return [{ now: new Date(this.now) }]
        const [id, companyId] = values
        if (sql.includes('FROM "trucks"')) return state.trucks.filter((row) => row.id === id && row.companyId === companyId).map((row) => ({ id: row.id }))
        if (sql.includes('FROM "users"')) return structuredClone(state.users.filter((row) => row.id === id
          && (row.companyId === companyId || (row.role === "SUPER_ADMIN" && row.companyId === null))))
        if (sql.includes('FROM "employees"')) return structuredClone(state.employees.filter((row) =>
          (/WHERE "userId"/.test(sql) ? row.userId === id : row.id === id) && row.companyId === companyId))
        if (sql.includes('FROM "teams"')) return structuredClone(state.teams.filter((row) => row.id === id && row.companyId === companyId))
        if (sql.includes('FROM "worksites"')) return structuredClone(state.worksites.filter((row) => row.id === id && row.companyId === companyId))
        throw new Error(`Unexpected SQL in mileage test: ${sql}`)
      },
      truck: {
        findFirst: async (args: Args) => find(state.trucks, "truck.findFirst", args),
        updateMany: async (args: Args) => update(state.trucks, "truck.updateMany", args),
      },
      mileageEntry: {
        findFirst: async (args: Args) => find(state.entries, "mileageEntry.findFirst", args),
        findMany: async (args: Args) => many(state.entries, "mileageEntry.findMany", args),
        create: async (args: Args) => {
          this.hit("mileageEntry.create", args)
          const row = { id: `entry-${++this.sequence}`, recordedAt: new Date(this.now), ...structuredClone(args.data) } as StoredEntry
          state.entries.push(row)
          return structuredClone(row)
        },
      },
      mileageTrip: {
        findFirst: async (args: Args) => find(state.trips, "mileageTrip.findFirst", args),
        findMany: async (args: Args) => many(state.trips, "mileageTrip.findMany", args),
        create: async (args: Args) => {
          this.hit("mileageTrip.create", args)
          const row = { id: `trip-${++this.sequence}`, endEntryId: null, ...structuredClone(args.data) } as StoredTrip
          state.trips.push(row)
          return structuredClone(row)
        },
        updateMany: async (args: Args) => update(state.trips, "mileageTrip.updateMany", args),
      },
    }
  }

  async $transaction<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>, options?: unknown): Promise<T> {
    const previous = this.queue
    let release!: () => void
    this.queue = new Promise<void>((resolve) => { release = resolve })
    await previous
    const local = structuredClone(this.state)
    this.hit("transaction.begin", options)
    try {
      const result = await callback(this.tx(local) as unknown as Prisma.TransactionClient)
      this.state = local
      this.hit("transaction.commit", null)
      return result
    } catch (error) {
      this.hit("transaction.rollback", null)
      throw error
    } finally {
      release()
    }
  }
}
