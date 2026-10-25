/**
 * Double mémoire V3 : clone/rollback transactionnel et file série déterministe.
 * Comme le double V2, il n'émule ni MVCC, ni triggers, ni FK PostgreSQL : il ne prouve aucun
 * verrou. Les contrats SQL sont couverts par la migration (contrat statique + rejeu PGlite)
 * et par les tests PostgreSQL réels exécutés hors de cette copie.
 */
import { createHash, randomUUID } from "node:crypto"
import type { Prisma } from "@prisma/client"
import type { MileageSession } from "@/lib/vehicules/mileage-access"
import type { DocumentServiceDeps, SignedFetchResult } from "@/lib/vehicules/v3/document-service"
import type { DocumentStorageLocation, DocumentStoragePort, DocumentStorageStoreResult } from "@/lib/vehicules/v3/document-storage.port"
import { buildDocumentStorageKey } from "@/lib/vehicules/v3/document-storage.port"

type Row = Record<string, unknown>
type Args = { where?: Row; data?: Row; select?: Row; orderBy?: Row | Row[]; distinct?: string[]; take?: number }

export const COMPANY = "company-a"
export const OTHER_COMPANY = "company-b"
export const TRUCK = "truck-a"
export const OTHER_TRUCK = "truck-b"
export const SERVER_NOW = new Date("2026-10-24T12:00:00.000Z")
export const ADMIN: MileageSession = { user: { id: "admin-a", role: "ADMIN", companyId: COMPANY } }
export const OTHER_ADMIN: MileageSession = { user: { id: "admin-b", role: "ADMIN", companyId: OTHER_COMPANY } }
export const LEADER: MileageSession = { user: { id: "leader-a", role: "TEAM_LEADER", companyId: COMPANY } }
export const NEXT_LEADER: MileageSession = { user: { id: "leader-b", role: "TEAM_LEADER", companyId: COMPANY } }
export const SUPER_ADMIN: MileageSession = { user: { id: "super", role: "SUPER_ADMIN", companyId: COMPANY } }
export const EMPLOYEE: MileageSession = { user: { id: "employee", role: "EMPLOYEE", companyId: COMPANY } }

export type Tables = {
  companies: Row[]; companySettings: Row[]; trucks: Row[]; users: Row[]; employees: Row[]; teams: Row[]
  vehicleMaintenanceEntry: Row[]; vehicleDocument: Row[]; vehicleDocumentVersion: Row[]
  vehicleDocumentReminderSetting: Row[]; vehicleDocumentReminder: Row[]; vehicleAuditLog: Row[]; notification: Row[]
}

export function initialTables(): Tables {
  const truck = { id: TRUCK, companyId: COMPANY, matricule: "AB-123-CD", marque: "Renault", modele: "Master", active: true, archivedAt: null, teamId: "team-a", chauffeurId: "driver-a", currentMileage: 120000, currentMileageEntryId: "entry-1", mileageRevision: 1, createdAt: SERVER_NOW }
  return {
    companies: [{ id: COMPANY, active: true }, { id: OTHER_COMPANY, active: true }],
    companySettings: [{ id: "settings-a", companyId: COMPANY, timezone: "Europe/Paris" }],
    trucks: [truck, { ...truck, id: OTHER_TRUCK, companyId: OTHER_COMPANY, matricule: "EF-456-GH", teamId: null, chauffeurId: null }],
    users: [
      { id: "admin-a", role: "ADMIN", companyId: COMPANY, active: true, name: "Admin A" },
      { id: "admin-a2", role: "ADMIN", companyId: COMPANY, active: true, name: "Admin A2" },
      { id: "admin-b", role: "ADMIN", companyId: OTHER_COMPANY, active: true, name: "Admin B" },
      { id: "leader-a", role: "TEAM_LEADER", companyId: COMPANY, active: true, name: "Leader A" },
      { id: "leader-b", role: "TEAM_LEADER", companyId: COMPANY, active: true, name: "Leader B" },
      { id: "super", role: "SUPER_ADMIN", companyId: null, active: true, name: "Super Admin" },
      { id: "employee", role: "EMPLOYEE", companyId: COMPANY, active: true, name: "Employee" },
    ],
    employees: [
      { id: "employee-a", userId: "leader-a", companyId: COMPANY, active: true, role: "TEAM_LEADER", firstName: "Alice", lastName: "Leader" },
      { id: "employee-b", userId: "leader-b", companyId: COMPANY, active: true, role: "TEAM_LEADER", firstName: "Bob", lastName: "Leader" },
      { id: "driver-a", userId: "employee", companyId: COMPANY, active: true, role: "EMPLOYEE", firstName: "Driver", lastName: "Initial" },
    ],
    teams: [
      { id: "team-a", companyId: COMPANY, leaderId: "employee-a", active: true, name: "Équipe initiale" },
      { id: "team-b", companyId: COMPANY, leaderId: "employee-b", active: true, name: "Nouvelle équipe" },
    ],
    vehicleMaintenanceEntry: [{ id: "maint-1", companyId: COMPANY, truckId: TRUCK, kind: "SERVICE", occurredAt: new Date("2026-09-01T00:00:00.000Z"), mileage: 118000 }],
    vehicleDocument: [], vehicleDocumentVersion: [], vehicleDocumentReminderSetting: [], vehicleDocumentReminder: [], vehicleAuditLog: [], notification: [],
  }
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
  return a === b
}

function matchesValue(actual: unknown, expected: unknown): boolean {
  if (expected !== null && typeof expected === "object" && !(expected instanceof Date) && !Array.isArray(expected)) {
    const op = expected as Row
    if ("some" in op) return Array.isArray(actual) && actual.some(row => matches(row as Row, op.some as Row))
    if ("in" in op) return (op.in as unknown[]).some((v) => same(actual, v))
    if ("not" in op) return !matchesValue(actual, op.not)
    if ("gte" in op || "lte" in op) return (!("gte" in op) || (actual as number) >= (op.gte as number)) && (!("lte" in op) || (actual as number) <= (op.lte as number))
    throw new Error(`Unsupported where operator ${JSON.stringify(expected)}`)
  }
  return same(actual, expected)
}

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR") return (value as Row[]).some(clause => matches(row, clause))
    if (key === "AND") return (Array.isArray(value) ? value : [value] as Row[]).every(clause => matches(row, clause))
    return matchesValue(row[key], value)
  })
}

const DEFAULTS: Partial<Record<keyof Tables, (now: Date) => Row>> = {
  vehicleDocument: (now) => ({ currentVersionId: null, revision: 1, archivedAt: null, archivedById: null, archivedByNameSnapshot: null, archiveReason: null, createdAt: now, updatedAt: now }),
  vehicleDocumentVersion: (now) => ({ uploadedAt: now, verifiedAt: null, verifiedById: null, verifiedByNameSnapshot: null, supersededAt: null, issuedOn: null, validFrom: null, validUntil: null, issuerName: null, referenceNumber: null, observations: null, mileage: null, maintenanceEntryId: null }),
  vehicleDocumentReminderSetting: (now) => ({ revision: 1, updatedAt: now }),
  vehicleDocumentReminder: (now) => ({ notificationId: null, createdAt: now }),
  vehicleAuditLog: (now) => ({ truckId: null, entityId: null, detail: null, createdAt: now }),
  notification: (now) => ({ read: false, readAt: null, link: null, metadata: null, createdAt: now }),
}

const UNIQUE: Partial<Record<keyof Tables, string[][]>> = {
  vehicleDocumentVersion: [["companyId", "truckId", "idempotencyKey"], ["documentId", "versionNumber"], ["companyId", "storageKey"]],
  vehicleDocumentReminder: [["versionId", "thresholdDays", "recipientUserId"]],
  vehicleDocumentReminderSetting: [["companyId"]],
}

export class V3MemoryDb {
  state = initialTables()
  now = SERVER_NOW
  calls: { operation: string; args: unknown }[] = []
  failOnce: { operation: string; error: unknown } | null = null
  private queue = Promise.resolve()
  private sequence = 0

  deps(session: MileageSession | null = ADMIN, storage = new MemoryDocumentStorage()): DocumentServiceDeps & { storage: MemoryDocumentStorage } {
    return { auth: async () => session, db: this as unknown as DocumentServiceDeps["db"], storage, fetchSigned: storage.fetchSigned, clock: () => this.now }
  }

  private hit(operation: string, args: unknown) {
    this.calls.push({ operation, args: structuredClone(args) })
    if (this.failOnce?.operation === operation) { const error = this.failOnce.error; this.failOnce = null; throw error }
  }

  private model(state: Tables, table: keyof Tables) {
    const rows = () => state[table]
    const matchesRow = (row: Row, where?: Row) => matches(table === "users" ? { ...row, employeeProfiles: state.employees.filter(profile => profile.userId === row.id) } : row, where)
    const order = (list: Row[], orderBy?: Row | Row[]) => {
      const specs = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []
      return [...list].sort((a, b) => {
        for (const spec of specs) for (const [key, dir] of Object.entries(spec)) {
          const x = a[key], y = b[key]
          const cmp = x instanceof Date && y instanceof Date ? x.getTime() - y.getTime() : typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))
          if (cmp !== 0) return dir === "desc" ? -cmp : cmp
        }
        return 0
      })
    }
    const project = (row: Row, select?: Row): Row => {
      if (!select) return structuredClone(row)
      const out: Row = {}
      for (const [key, value] of Object.entries(select)) {
        if (!value) continue
        if (key === "employeeProfiles" && table === "users") {
          const relation = value as { where?: Row; select?: Row }
          const profiles = state.employees.filter(profile => profile.userId === row.id && matches(profile, relation.where))
          out.employeeProfiles = profiles.map(profile => relation.select ? Object.fromEntries(Object.entries(relation.select).filter(([, include]) => include).map(([column]) => [column, structuredClone(profile[column])])) : structuredClone(profile))
        }
        else if (key === "user" && table === "employees") out.user = structuredClone(state.users.find((user) => user.id === row.userId) ?? null)
        else out[key] = structuredClone(row[key])
      }
      return out
    }
    const assertUnique = (candidate: Row, exceptId?: unknown) => {
      for (const keys of UNIQUE[table] ?? []) {
        if (rows().some((row) => row.id !== exceptId && keys.every((key) => same(row[key], candidate[key])))) {
          const error = new Error(`Unique constraint failed on ${keys.join(",")}`) as Error & { code: string; meta: Row }
          error.code = "P2002"; error.meta = { target: keys }
          throw error
        }
      }
    }
    return {
      findFirst: async (args: Args = {}) => { this.hit(`${table}.findFirst`, args); const row = order(rows().filter((r) => matchesRow(r, args.where)), args.orderBy)[0]; return row ? project(row, args.select) : null },
      findMany: async (args: Args = {}) => {
        this.hit(`${table}.findMany`, args)
        let list = order(rows().filter((r) => matchesRow(r, args.where)), args.orderBy)
        if (args.distinct) { const seen = new Set<string>(); list = list.filter((r) => { const k = args.distinct!.map((d) => String(r[d])).join("|"); if (seen.has(k)) return false; seen.add(k); return true }) }
        if (args.take) list = list.slice(0, args.take)
        return list.map((r) => project(r, args.select))
      },
      count: async (args: Args = {}) => { this.hit(`${table}.count`, args); return rows().filter((r) => matchesRow(r, args.where)).length },
      create: async (args: Args) => {
        this.hit(`${table}.create`, args)
        const row: Row = { id: `${table}-${++this.sequence}`, ...(DEFAULTS[table]?.(this.now) ?? {}), ...structuredClone(args.data) }
        assertUnique(row)
        rows().push(row)
        return structuredClone(row)
      },
      update: async (args: Args) => {
        this.hit(`${table}.update`, args)
        const row = rows().find((r) => matchesRow(r, args.where))
        if (!row) { const error = new Error("Record not found") as Error & { code: string }; error.code = "P2025"; throw error }
        Object.assign(row, structuredClone(args.data))
        return structuredClone(row)
      },
      updateMany: async (args: Args) => {
        this.hit(`${table}.updateMany`, args)
        const found = rows().filter((r) => matchesRow(r, args.where))
        for (const row of found) Object.assign(row, structuredClone(args.data))
        return { count: found.length }
      },
    }
  }

  private tx(state: Tables) {
    const models: Record<string, unknown> = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?").replace(/\s+/g, " ").trim()
        this.hit("$queryRaw", { sql, values })
        if (sql.includes("clock_timestamp()")) return [{ now: new Date(this.now) }]
        const [id, companyId] = values
        if (sql.includes('FROM "trucks"')) return state.trucks.filter((row) => row.id === id && row.companyId === companyId).map((row) => ({ id: row.id }))
        if (sql.includes('FROM "companies"')) return structuredClone(state.companies.filter((row) => row.id === id))
        if (sql.includes('FROM "users"')) return structuredClone(state.users.filter((row) => row.id === id))
        if (sql.includes('FROM "employees"') && /WHERE "companyId"/.test(sql)) return structuredClone(state.employees.filter(row => row.companyId === id && row.userId === companyId))
        if (sql.includes('FROM "employees"')) return structuredClone(state.employees.filter((row) => (/WHERE "userId"/.test(sql) ? row.userId === id : row.id === id) && row.companyId === companyId))
        if (sql.includes('FROM "teams"')) return structuredClone(state.teams.filter((row) => row.id === id && row.companyId === companyId))
        throw new Error(`Unexpected SQL in V3 test: ${sql}`)
      },
      truck: this.model(state, "trucks"),
      user: this.model(state, "users"),
      employee: this.model(state, "employees"),
      companySettings: this.model(state, "companySettings"),
    }
    for (const table of ["vehicleMaintenanceEntry", "vehicleDocument", "vehicleDocumentVersion", "vehicleDocumentReminderSetting", "vehicleDocumentReminder", "vehicleAuditLog", "notification"] as const) models[table] = this.model(state, table)
    return models
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
    } finally { release() }
  }
}

/** Stockage mémoire : clés déterministes, objets conservés, liens signés factices jamais exposés par le service. */
export class MemoryDocumentStorage implements DocumentStoragePort {
  readonly provider = "cloudinary" as const
  objects = new Map<string, Uint8Array>()
  stored: string[] = []
  destroyed: string[] = []
  signed: string[] = []
  failNextStore = false
  failNextDestroy = false

  async store(location: DocumentStorageLocation, bytes: Uint8Array): Promise<DocumentStorageStoreResult> {
    if (this.failNextStore) { this.failNextStore = false; throw new Error("DOCUMENT_STORAGE_FAILED") }
    const storageKey = buildDocumentStorageKey(location, { VEHICLE_DOCUMENT_CLOUDINARY_FOLDER_PREFIX: "test" } as unknown as NodeJS.ProcessEnv)
    const created = !this.objects.has(storageKey)
    if (created) this.objects.set(storageKey, new Uint8Array(bytes))
    this.stored.push(storageKey)
    return { storageKey, created }
  }

  async destroy(storageKey: string): Promise<void> {
    if (this.failNextDestroy) { this.failNextDestroy = false; throw new Error("DOCUMENT_STORAGE_COMPENSATION_FAILED") }
    this.objects.delete(storageKey)
    this.destroyed.push(storageKey)
  }

  async createSignedUrl(storageKey: string, expiresAt: Date): Promise<string> {
    const url = `https://signed.invalid/${encodeURIComponent(storageKey)}?exp=${expiresAt.getTime()}&signature=secret-signature`
    this.signed.push(url)
    return url
  }

  fetchSigned = async (url: string): Promise<SignedFetchResult> => {
    const key = decodeURIComponent(new URL(url).pathname.slice(1))
    const bytes = this.objects.get(key)
    if (!bytes) return { ok: false, status: 404, body: null, contentLength: null }
    return { ok: true, status: 200, contentLength: bytes.byteLength, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close() } }) }
  }
}

// ─── Fixtures de fichiers ────────────────────────────────────────────────────

export const PDF_BYTES = new Uint8Array(Buffer.from("%PDF-1.4\n1 0 obj<< /Type /Catalog >>endobj\ntrailer<< /Root 1 0 R >>\n%%EOF\n", "latin1"))
export const PDF_WITH_JS = new Uint8Array(Buffer.from("%PDF-1.4\n1 0 obj<< /Type /Catalog /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>endobj\n%%EOF\n", "latin1"))
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82])
export const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1])
export const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

let keySequence = 0
export function key() { return `00000000-0000-4000-8000-${String(++keySequence).padStart(12, "0")}` }
export const uuid = () => randomUUID()
export const pdfFile = (filename = "controle-technique.pdf", bytes: Uint8Array = PDF_BYTES) => ({ filename, declaredMimeType: "application/pdf", bytes })
export async function streamToBuffer(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value) }
  return Buffer.concat(chunks)
}
