/**
 * LOT-1W-1a — Harnais de parité (FICHE-LOT-1W-1a rév. 3, §3.1).
 *
 * Exécute les Server Actions `createChantier` et `affecterEquipe` du module RÉEL
 * `src/lib/actions/chantier.actions.ts` (aucune réécriture), avec des doubles de modules posés
 * aux cinq frontières via `node:test` `mock.module` (drapeau `--experimental-test-module-mocks`) :
 *
 *   `@/auth`                  session simulée (ADMIN complet / absente / EMPLOYEE / sans companyId)
 *   `@/lib/prisma`            client enregistreur : chaque appel journalise { model, method, args, inTx }
 *                             ; `$transaction(fn)` exécute `fn` avec un `tx` qui journalise inTx: true,
 *                             une erreur levée dans `fn` ⇒ rejet (rollback simulé), comme Prisma
 *   `@/lib/geo/geocode.port`  `defaultGeocodePort.geocodeAddress` : succès / null / exception
 *   `@/lib/email`             `sendAssignmentCreatedEmail` : promesse résolue / rejetée
 *   `next/cache`              `revalidatePath` : chemins et ordre
 *
 * Horloge figée (`mock.timers`, API Date) à FROZEN_CLOCK_ISO ; le fuseau est celui du processus
 * (`TZ`), imposé par la commande (UTC puis Europe/Paris).
 *
 * Les mêmes cas, les mêmes doubles, la même horloge et le même `TZ` servent (1) à enregistrer la
 * référence sur BASE_SHA (`record-reference.ts`) et (2) à rejouer adaptateur + cœur après refactor
 * (`tests/chantiers/*.core.test.ts`). Rien ici ne dépend de la forme interne des actions.
 *
 * Contrainte d'exécution : tsx charge les `.ts` du dépôt en CommonJS (pas de `"type": "module"`),
 * donc aucun `await` de premier niveau ; les modules mockés sont importés dynamiquement après
 * `installModuleDoubles()`.
 */

import { mock } from "node:test"

// ---- Constantes figées -------------------------------------------------------------------------

/** SHA de `origin/main` relevé par `git fetch origin` le 2026-10-22 (fiche §3.2, étape 1). */
export const BASE_SHA = "a84c73fe7e89c04943e356df99679fe0aca83ed1"

/** Horloge figée (fiche §3.1). */
export const FROZEN_CLOCK_ISO = "2026-11-02T08:00:00Z"

/** Fuseaux de capture admis et suffixe de fichier correspondant. */
export const SUPPORTED_TZ: Readonly<Record<string, string>> = {
  UTC: "utc",
  "Europe/Paris": "europe-paris",
}

/** Commande d'enregistrement (fiche §3.3 / §9.1), préfixée par `TZ=<fuseau>`. */
export const RECORD_COMMAND =
  "node --import tsx --experimental-test-module-mocks tests/chantiers/parity/record-reference.ts"

/** Chemin du dossier des références, relatif à la racine du dépôt. */
export const REFERENCE_DIR = "tests/chantiers/parity/reference"

/** Frontières doublées (spécificateurs tels qu'importés par `chantier.actions.ts`). */
export const DOUBLED_MODULES = [
  "@/auth",
  "@/lib/prisma",
  "@/lib/geo/geocode.port",
  "@/lib/email",
  "next/cache",
] as const

// ---- Trace -------------------------------------------------------------------------------------

export type ErrorShape = { name: string; message: string }

export type TraceEntry =
  | { kind: "auth"; session: SessionKind }
  | { kind: "prisma"; model: string; method: string; args: unknown; inTx: boolean }
  | { kind: "tx"; event: "begin" }
  | { kind: "tx"; event: "commit" }
  | { kind: "tx"; event: "rollback"; error: ErrorShape }
  | { kind: "geocode"; address: string; outcome: GeocodeMode }
  | { kind: "email"; fn: string; args: unknown; outcome: EmailMode }
  | { kind: "revalidatePath"; path: string }
  | { kind: "console.error"; args: unknown[] }

export type SessionKind = "admin" | "none" | "employee" | "noCompany"
export type GeocodeMode = "ok" | "null" | "throw"
export type EmailMode = "resolve" | "reject"

/** Réponse scriptée d'une méthode Prisma ; `nth` = rang (1-based) de l'appel à cette clé dans le cas. */
export type DbResponder = (args: unknown, nth: number) => unknown
/** Clé : `model.method` (ex. `worksite.findFirst`). */
export type DbScript = Readonly<Record<string, DbResponder>>

export type ParityCase = {
  id: string
  action: "createChantier" | "affecterEquipe"
  title: string
  session: SessionKind
  /** Champs du formulaire ; une clé absente est absente du `FormData` (`get` ⇒ null). */
  form: Readonly<Record<string, string>>
  geocode?: GeocodeMode
  email?: EmailMode
  db?: DbScript
}

export type CaseResult = { returned: unknown } | { threw: ErrorShape }

export type CaseRecord = {
  id: string
  action: ParityCase["action"]
  title: string
  input: {
    session: SessionKind
    form: Readonly<Record<string, string>>
    geocode: GeocodeMode | null
    email: EmailMode
    dbScriptKeys: string[]
  }
  result: CaseResult
  trace: TraceEntry[]
}

// ---- Sessions simulées (fiche §3.1 / §3bis-4bis) ----------------------------------------------

type FakeSession = { user: { id: string; role: string; companyId: string | null; email: string; name: string } } | null

const SESSIONS: Readonly<Record<SessionKind, FakeSession>> = {
  admin: { user: { id: "user-admin-1", role: "ADMIN", companyId: "company-A", email: "admin@example.test", name: "Admin Test" } },
  none: null,
  employee: { user: { id: "user-employee-1", role: "EMPLOYEE", companyId: "company-A", email: "employe@example.test", name: "Employé Test" } },
  noCompany: { user: { id: "user-admin-2", role: "ADMIN", companyId: null, email: "admin2@example.test", name: "Admin Sans Entreprise" } },
}

// ---- État mutable partagé par les doubles ------------------------------------------------------

type HarnessState = {
  session: SessionKind
  geocode: GeocodeMode | null
  email: EmailMode
  db: DbScript
  counts: Map<string, number>
  trace: TraceEntry[]
  unscripted: string[]
}

const state: HarnessState = {
  session: "admin",
  geocode: null,
  email: "resolve",
  db: {},
  counts: new Map(),
  trace: [],
  unscripted: [],
}

function resetState(c: ParityCase): void {
  state.session = c.session
  state.geocode = c.geocode ?? null
  state.email = c.email ?? "resolve"
  state.db = c.db ?? {}
  state.counts = new Map()
  state.trace = []
  state.unscripted = []
}

// ---- Sérialisation stable des valeurs enregistrées ---------------------------------------------

/** Forme JSON stable : Date ⇒ {$date}, undefined ⇒ {$undefined}, NaN/±Infinity explicites, ordre des clés conservé. */
export function toSnapshot(value: unknown): unknown {
  if (value === undefined) return { $undefined: true }
  if (value === null) return null
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { $nan: true }
    if (value === Infinity) return { $infinity: 1 }
    if (value === -Infinity) return { $infinity: -1 }
    return value
  }
  if (typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "bigint") return { $bigint: value.toString() }
  if (typeof value === "function") return { $function: value.name || "anonymous" }
  if (typeof value === "symbol") return { $symbol: value.description ?? "" }
  if (value instanceof Date) {
    return { $date: Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString() }
  }
  if (value instanceof Error) return { $error: errorShape(value) }
  if (Array.isArray(value)) return value.map(toSnapshot)
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = toSnapshot((value as Record<string, unknown>)[key])
    }
    return out
  }
  return { $unknown: String(value) }
}

export function errorShape(err: unknown): ErrorShape {
  if (err instanceof Error) return { name: err.name, message: err.message }
  return { name: "NonError", message: String(err) }
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n"
}

// ---- Double Prisma : client enregistreur -------------------------------------------------------

class UnscriptedCallError extends Error {
  constructor(key: string) {
    super(`[harness] appel Prisma non scripté : ${key}`)
    this.name = "UnscriptedCallError"
  }
}

function makeModelProxy(model: string, inTx: boolean): unknown {
  return new Proxy(
    {},
    {
      get(_target, method) {
        if (typeof method !== "string") return undefined
        if (method === "then") return undefined // jamais un thenable
        return async (args: unknown) => {
          const key = `${model}.${method}`
          const nth = (state.counts.get(key) ?? 0) + 1
          state.counts.set(key, nth)
          state.trace.push({ kind: "prisma", model, method, args: toSnapshot(args), inTx })
          const responder = state.db[key]
          if (!responder) {
            state.unscripted.push(key)
            throw new UnscriptedCallError(key)
          }
          return responder(args, nth)
        }
      },
    }
  )
}

function makeRootClient(): unknown {
  const txClient = new Proxy(
    {},
    {
      get(_target, model) {
        if (typeof model !== "string") return undefined
        if (model === "then") return undefined
        if (model.startsWith("$")) throw new Error(`[harness] ${model} indisponible sur le client transactionnel`)
        return makeModelProxy(model, true)
      },
    }
  )
  return new Proxy(
    {},
    {
      get(_target, model) {
        if (typeof model !== "string") return undefined
        if (model === "then") return undefined
        if (model === "$transaction") {
          return async (arg: unknown) => {
            if (typeof arg !== "function") {
              throw new Error("[harness] $transaction(tableau) non supporté par le harnais (non utilisé par les actions du lot)")
            }
            state.trace.push({ kind: "tx", event: "begin" })
            try {
              const result = await (arg as (tx: unknown) => Promise<unknown>)(txClient)
              state.trace.push({ kind: "tx", event: "commit" })
              return result
            } catch (err) {
              state.trace.push({ kind: "tx", event: "rollback", error: errorShape(err) })
              throw err
            }
          }
        }
        if (model.startsWith("$")) throw new Error(`[harness] ${model} non supporté par le harnais`)
        return makeModelProxy(model, false)
      },
    }
  )
}

// ---- Doubles des autres frontières -------------------------------------------------------------

const authDouble = async (): Promise<FakeSession> => {
  state.trace.push({ kind: "auth", session: state.session })
  return SESSIONS[state.session]
}

const geocodeDouble = {
  geocodeAddress: async (address: string): Promise<{ latitude: number; longitude: number } | null> => {
    const mode = state.geocode
    if (mode === null) {
      state.unscripted.push("geocode")
      throw new Error("[harness] géocodage non scripté pour ce cas")
    }
    state.trace.push({ kind: "geocode", address, outcome: mode })
    if (mode === "ok") return { latitude: 48.8566, longitude: 2.3522 }
    if (mode === "null") return null
    throw new Error("[double] geocode boom")
  },
}

function emailDouble(fn: string) {
  return (args: unknown): Promise<void> => {
    const mode = state.email
    state.trace.push({ kind: "email", fn, args: toSnapshot(args), outcome: mode })
    if (mode === "reject") return Promise.reject(new Error("[double] email rejected"))
    return Promise.resolve()
  }
}

const revalidatePathDouble = (path: string): void => {
  state.trace.push({ kind: "revalidatePath", path })
}

// ---- Installation ------------------------------------------------------------------------------

let installed = false

/**
 * Pose les doubles de modules et fige l'horloge. À appeler AVANT tout import (même indirect) de
 * `@/lib/actions/chantier.actions`. Idempotent dans le processus.
 */
export function installModuleDoubles(): void {
  if (installed) return
  installed = true
  mock.timers.enable({ apis: ["Date"], now: Date.parse(FROZEN_CLOCK_ISO) })
  mock.module("@/auth", { namedExports: { auth: authDouble } })
  mock.module("@/lib/prisma", { namedExports: { prisma: makeRootClient() } })
  mock.module("@/lib/geo/geocode.port", { namedExports: { defaultGeocodePort: geocodeDouble } })
  mock.module("@/lib/email", {
    namedExports: {
      sendAssignmentCreatedEmail: emailDouble("sendAssignmentCreatedEmail"),
      sendAssignmentConfirmedEmail: emailDouble("sendAssignmentConfirmedEmail"),
      sendAssignmentRefusedEmail: emailDouble("sendAssignmentRefusedEmail"),
    },
  })
  mock.module("next/cache", { namedExports: { revalidatePath: revalidatePathDouble } })
}

export type ActionsModule = typeof import("@/lib/actions/chantier.actions")

/** Importe le module réel des actions (après installation des doubles). Lève si le chargement échoue. */
export async function loadActions(): Promise<ActionsModule> {
  installModuleDoubles()
  return import("@/lib/actions/chantier.actions")
}

// ---- Exécution d'un cas ------------------------------------------------------------------------

function buildFormData(form: Readonly<Record<string, string>>): FormData {
  const fd = new FormData()
  for (const [key, value] of Object.entries(form)) fd.set(key, value)
  return fd
}

export async function runCase(actions: ActionsModule, c: ParityCase): Promise<CaseRecord> {
  resetState(c)
  const originalConsoleError = console.error
  console.error = (...args: unknown[]) => {
    state.trace.push({ kind: "console.error", args: args.map(toSnapshot) })
  }
  let result: CaseResult
  try {
    const fd = buildFormData(c.form)
    const returned = c.action === "createChantier" ? await actions.createChantier(fd) : await actions.affecterEquipe(fd)
    result = { returned: toSnapshot(returned) }
  } catch (err) {
    result = { threw: errorShape(err) }
  } finally {
    console.error = originalConsoleError
  }
  // Laisse s'écouler les micro-tâches (rejet d'e-mail fire-and-forget absorbé par `.catch`).
  await new Promise<void>((resolve) => setImmediate(resolve))
  if (state.unscripted.length > 0) {
    throw new Error(`[harness] cas ${c.id} : appel(s) non scripté(s) ${state.unscripted.join(", ")} — le cas doit être complété, pas la trace`)
  }
  return {
    id: c.id,
    action: c.action,
    title: c.title,
    input: {
      session: c.session,
      form: c.form,
      geocode: c.geocode ?? null,
      email: c.email ?? "resolve",
      dbScriptKeys: Object.keys(c.db ?? {}),
    },
    result,
    trace: state.trace.slice(),
  }
}

export function referenceFileName(caseId: string, tz: string): string {
  const slug = SUPPORTED_TZ[tz]
  if (!slug) throw new Error(`[harness] TZ non supporté : ${tz}`)
  return `${caseId}.${slug}.json`
}

// ---- Jeu de cas (fiche §4 : T-CORE-1, T-CORE-2, T-CORE-3, T-CORE-7) ----------------------------

const CREATE_FORM_OK: Readonly<Record<string, string>> = {
  name: "Rénovation toiture",
  description: "Réfection complète",
  address: "12 rue des Lilas, 75020 Paris",
  clientId: "client-1",
  startDate: "2026-11-03",
  endDate: "2026-11-05",
  dailyHours: "8",
}

const CLIENT_ROW = () => ({ id: "client-1", companyId: "company-A", name: "Client Un" })
const CLIENT_FOUND: DbScript = { "client.findFirst": () => CLIENT_ROW() }
const WORKSITE_CREATED: DbScript = { "worksite.create": () => ({ id: "worksite-new-1" }) }

const WORKSITE_ROW = (over: Partial<{ status: string; name: string; address: string | null }> = {}) => ({
  id: "worksite-1",
  companyId: "company-A",
  name: "Chantier Alpha",
  address: "5 avenue du Port, Le Havre",
  status: "PLANNED",
  ...over,
})

type TeamOver = Partial<{ members: { employeeId: string }[]; leader: { userId: string | null } | null; name: string }>
const TEAM_ROW = (over: TeamOver = {}) => ({
  id: "team-1",
  companyId: "company-A",
  name: "Équipe Nord",
  members: [{ employeeId: "employee-1" }, { employeeId: "employee-2" }],
  leader: { userId: "user-leader-1" },
  ...over,
})

const ASSIGN_FORM_3D: Readonly<Record<string, string>> = {
  worksiteId: "worksite-1",
  teamId: "team-1",
  dateFrom: "2026-11-03",
  dateTo: "2026-11-05",
}

/** Script Prisma « chemin nominal » d'affecterEquipe ; chaque clé est surchargeable. */
function assignDb(over: DbScript = {}): DbScript {
  return {
    "worksite.findFirst": () => WORKSITE_ROW(),
    "team.findFirst": () => TEAM_ROW(),
    "assignment.findFirst": () => null,
    "employeeAssignment.findMany": () => [],
    "assignment.create": (_args, nth) => ({ id: `assignment-${nth}` }),
    "employeeAssignment.createMany": (args) => ({ count: (args as { data: unknown[] }).data.length }),
    "worksite.update": () => ({ id: "worksite-1", status: "IN_PROGRESS" }),
    "notification.create": () => ({ id: "notification-1" }),
    "user.findUnique": () => ({ email: "chef.nord@example.test", name: "Chef Nord" }),
    "company.findUnique": () => ({ name: "Entreprise A" }),
    ...over,
  }
}

const TEAM_CONFLICT_ROW = (address: string | null, dateIso = "2026-11-04T00:00:00.000Z") => ({
  id: "assignment-existing-1",
  teamId: "team-1",
  worksiteId: "worksite-2",
  date: new Date(dateIso),
  status: "CONFIRMED",
  worksite: { name: "Chantier Bêta", address },
})

const EMPLOYEE_CONFLICT_ROWS = (n: 1 | 2) => {
  const rows = [
    {
      id: "ea-1",
      employeeId: "employee-1",
      assignmentId: "assignment-existing-2",
      date: new Date("2026-11-04T00:00:00.000Z"),
      employee: { firstName: "Alice", lastName: "Martin" },
      assignment: { worksite: { name: "Chantier Gamma" }, team: { name: "Équipe Sud" } },
    },
    {
      id: "ea-2",
      employeeId: "employee-2",
      assignmentId: "assignment-existing-3",
      date: new Date("2026-11-05T00:00:00.000Z"),
      employee: { firstName: "Bruno", lastName: "Durand" },
      assignment: { worksite: { name: "Chantier Delta" }, team: { name: "Équipe Est" } },
    },
  ]
  return rows.slice(0, n)
}

export const CASES: readonly ParityCase[] = [
  // ---- T-CORE-1 : createChantier -------------------------------------------------------------
  {
    id: "create-valid-geocode-ok",
    action: "createChantier",
    title: "entrée valide avec adresse, géocodage réussi",
    session: "admin",
    form: CREATE_FORM_OK,
    geocode: "ok",
    db: { ...CLIENT_FOUND, ...WORKSITE_CREATED },
  },
  {
    id: "create-valid-geocode-null",
    action: "createChantier",
    title: "entrée valide avec adresse, géocodage sans résultat (null)",
    session: "admin",
    form: CREATE_FORM_OK,
    geocode: "null",
    db: { ...CLIENT_FOUND, ...WORKSITE_CREATED },
  },
  {
    id: "create-valid-no-address",
    action: "createChantier",
    title: "entrée valide sans adresse ni description (chaînes vides) : aucun géocodage",
    session: "admin",
    form: { ...CREATE_FORM_OK, address: "", description: "" },
    db: { ...CLIENT_FOUND, ...WORKSITE_CREATED },
  },
  {
    id: "create-valid-dailyhours-fraction",
    action: "createChantier",
    title: "dailyHours fractionnaire accepté par z.coerce.number()",
    session: "admin",
    form: { ...CREATE_FORM_OK, address: "", dailyHours: "7.5" },
    db: { ...CLIENT_FOUND, ...WORKSITE_CREATED },
  },
  {
    id: "create-valid-same-day",
    action: "createChantier",
    title: "endDate = startDate (refine >= accepte)",
    session: "admin",
    form: { ...CREATE_FORM_OK, address: "", startDate: "2026-11-03", endDate: "2026-11-03" },
    db: { ...CLIENT_FOUND, ...WORKSITE_CREATED },
  },
  {
    id: "create-geocode-throws",
    action: "createChantier",
    title: "exception du géocodage : traitement observé à BASE_SHA (aucune capture dans l'action)",
    session: "admin",
    form: CREATE_FORM_OK,
    geocode: "throw",
    db: { ...CLIENT_FOUND, ...WORKSITE_CREATED },
  },
  {
    id: "create-worksite-create-throws",
    action: "createChantier",
    title: "erreur de worksite.create : traitement observé à BASE_SHA",
    session: "admin",
    form: { ...CREATE_FORM_OK, address: "" },
    db: {
      ...CLIENT_FOUND,
      "worksite.create": () => {
        throw new Error("[double] worksite.create failed (P2003)")
      },
    },
  },
  {
    id: "create-client-not-found",
    action: "createChantier",
    title: "client introuvable dans l'entreprise",
    session: "admin",
    form: CREATE_FORM_OK,
    db: { "client.findFirst": () => null },
  },
  {
    id: "create-zod-name-empty",
    action: "createChantier",
    title: "Zod : name vide",
    session: "admin",
    form: { ...CREATE_FORM_OK, name: "" },
  },
  {
    id: "create-zod-name-too-long",
    action: "createChantier",
    title: "Zod : name > 100 caractères",
    session: "admin",
    form: { ...CREATE_FORM_OK, name: "x".repeat(101) },
  },
  {
    id: "create-zod-description-absent",
    action: "createChantier",
    title: "Zod : champ description absent du FormData (null, pas undefined)",
    session: "admin",
    form: (() => {
      const { description: _omit, ...rest } = CREATE_FORM_OK
      void _omit
      return rest
    })(),
  },
  {
    id: "create-zod-client-empty",
    action: "createChantier",
    title: "Zod : clientId vide",
    session: "admin",
    form: { ...CREATE_FORM_OK, clientId: "" },
  },
  {
    id: "create-zod-startdate-empty",
    action: "createChantier",
    title: "Zod : startDate vide",
    session: "admin",
    form: { ...CREATE_FORM_OK, startDate: "" },
  },
  {
    id: "create-zod-enddate-empty",
    action: "createChantier",
    title: "Zod : endDate vide",
    session: "admin",
    form: { ...CREATE_FORM_OK, endDate: "" },
  },
  {
    id: "create-zod-enddate-before-startdate",
    action: "createChantier",
    title: "Zod : endDate < startDate (refine)",
    session: "admin",
    form: { ...CREATE_FORM_OK, startDate: "2026-11-05", endDate: "2026-11-03" },
  },
  {
    id: "create-zod-dailyhours-below-min",
    action: "createChantier",
    title: "Zod : dailyHours 0 (< 1)",
    session: "admin",
    form: { ...CREATE_FORM_OK, dailyHours: "0" },
  },
  {
    id: "create-zod-dailyhours-above-max",
    action: "createChantier",
    title: "Zod : dailyHours 25 (> 24)",
    session: "admin",
    form: { ...CREATE_FORM_OK, dailyHours: "25" },
  },
  {
    id: "create-zod-dailyhours-empty",
    action: "createChantier",
    title: "Zod : dailyHours vide (coerce ⇒ 0)",
    session: "admin",
    form: { ...CREATE_FORM_OK, dailyHours: "" },
  },
  {
    id: "create-zod-dailyhours-nan",
    action: "createChantier",
    title: "Zod : dailyHours non numérique (coerce ⇒ NaN)",
    session: "admin",
    form: { ...CREATE_FORM_OK, dailyHours: "huit" },
  },
  {
    id: "create-zod-startdate-invalid",
    action: "createChantier",
    title: "Zod : startDate non parsable (refine compare Invalid Date)",
    session: "admin",
    form: { ...CREATE_FORM_OK, startDate: "pas-une-date" },
  },
  // ---- T-CORE-3 : auth/autorisation de createChantier -----------------------------------------
  {
    id: "create-auth-session-absent",
    action: "createChantier",
    title: "session absente ⇒ exception, trace Prisma vide",
    session: "none",
    form: CREATE_FORM_OK,
  },
  {
    id: "create-auth-role-employee",
    action: "createChantier",
    title: "rôle EMPLOYEE ⇒ exception, trace Prisma vide",
    session: "employee",
    form: CREATE_FORM_OK,
  },
  {
    id: "create-auth-no-company",
    action: "createChantier",
    title: "companyId absent ⇒ exception, trace Prisma vide",
    session: "noCompany",
    form: CREATE_FORM_OK,
  },

  // ---- T-CORE-2 : affecterEquipe ---------------------------------------------------------------
  {
    id: "assign-one-day",
    action: "affecterEquipe",
    title: "plage d'un jour (dateTo = dateFrom)",
    session: "admin",
    form: { ...ASSIGN_FORM_3D, dateTo: "2026-11-03" },
    db: assignDb(),
  },
  {
    id: "assign-multi-day",
    action: "affecterEquipe",
    title: "plage de trois jours",
    session: "admin",
    form: ASSIGN_FORM_3D,
    db: assignDb(),
  },
  {
    id: "assign-multi-day-month-boundary",
    action: "affecterEquipe",
    title: "plage à cheval sur deux mois (libellés fr-FR)",
    session: "admin",
    form: { ...ASSIGN_FORM_3D, dateFrom: "2026-11-30", dateTo: "2026-12-02" },
    db: assignDb(),
  },
  {
    id: "assign-range-across-dst",
    action: "affecterEquipe",
    title: "plage traversant le changement d'heure Europe/Paris (25 octobre 2026) — T-CORE-7",
    session: "admin",
    form: { ...ASSIGN_FORM_3D, dateFrom: "2026-10-24", dateTo: "2026-10-26" },
    db: assignDb(),
  },
  {
    id: "assign-datefrom-with-time",
    action: "affecterEquipe",
    title: "dateFrom avec heure (setHours(0,0,0,0) dépend du fuseau) — T-CORE-7",
    session: "admin",
    form: { ...ASSIGN_FORM_3D, dateFrom: "2026-11-03T22:30:00.000Z", dateTo: "2026-11-04T01:15:00.000Z" },
    db: assignDb(),
  },
  {
    id: "assign-dateto-absent",
    action: "affecterEquipe",
    title: "dateTo absent (chaîne vide) ⇒ un seul jour",
    session: "admin",
    form: { ...ASSIGN_FORM_3D, dateTo: "" },
    db: assignDb(),
  },
  {
    id: "assign-dateto-key-missing",
    action: "affecterEquipe",
    title: "clé dateTo absente du FormData ⇒ un seul jour",
    session: "admin",
    form: { worksiteId: "worksite-1", teamId: "team-1", dateFrom: "2026-11-03" },
    db: assignDb(),
  },
  {
    id: "assign-dateto-before-datefrom",
    action: "affecterEquipe",
    title: "dateTo < dateFrom",
    session: "admin",
    form: { ...ASSIGN_FORM_3D, dateFrom: "2026-11-05", dateTo: "2026-11-03" },
  },
  {
    id: "assign-missing-worksiteid",
    action: "affecterEquipe",
    title: "worksiteId manquant ⇒ « Informations manquantes. »",
    session: "admin",
    form: { ...ASSIGN_FORM_3D, worksiteId: "" },
  },
  {
    id: "assign-missing-teamid",
    action: "affecterEquipe",
    title: "teamId manquant ⇒ « Informations manquantes. »",
    session: "admin",
    form: { ...ASSIGN_FORM_3D, teamId: "" },
  },
  {
    id: "assign-missing-datefrom",
    action: "affecterEquipe",
    title: "dateFrom manquant ⇒ « Informations manquantes. »",
    session: "admin",
    form: { worksiteId: "worksite-1", teamId: "team-1" },
  },
  {
    id: "assign-worksite-not-found",
    action: "affecterEquipe",
    title: "chantier introuvable",
    session: "admin",
    form: ASSIGN_FORM_3D,
    db: assignDb({ "worksite.findFirst": () => null }),
  },
  {
    id: "assign-team-not-found",
    action: "affecterEquipe",
    title: "équipe introuvable",
    session: "admin",
    form: ASSIGN_FORM_3D,
    db: assignDb({ "team.findFirst": () => null }),
  },
  {
    id: "assign-team-conflict-with-address",
    action: "affecterEquipe",
    title: "conflit équipe, chantier existant avec adresse",
    session: "admin",
    form: ASSIGN_FORM_3D,
    db: assignDb({ "assignment.findFirst": () => TEAM_CONFLICT_ROW("3 place du Marché, Rouen") }),
  },
  {
    id: "assign-team-conflict-without-address",
    action: "affecterEquipe",
    title: "conflit équipe, chantier existant sans adresse",
    session: "admin",
    form: ASSIGN_FORM_3D,
    db: assignDb({ "assignment.findFirst": () => TEAM_CONFLICT_ROW(null) }),
  },
  {
    id: "assign-team-conflict-late-evening-date",
    action: "affecterEquipe",
    title: "conflit équipe dont la date est 23:30 UTC (libellé dépend du fuseau) — T-CORE-7",
    session: "admin",
    form: ASSIGN_FORM_3D,
    db: assignDb({ "assignment.findFirst": () => TEAM_CONFLICT_ROW(null, "2026-11-04T23:30:00.000Z") }),
  },
  {
    id: "assign-employee-conflict-one",
    action: "affecterEquipe",
    title: "conflit d'un employé (« Désaffectez-le »)",
    session: "admin",
    form: ASSIGN_FORM_3D,
    db: assignDb({ "employeeAssignment.findMany": () => EMPLOYEE_CONFLICT_ROWS(1) }),
  },
  {
    id: "assign-employee-conflict-many",
    action: "affecterEquipe",
    title: "conflits de deux employés (« Désaffectez-les »)",
    session: "admin",
    form: ASSIGN_FORM_3D,
    db: assignDb({ "employeeAssignment.findMany": () => EMPLOYEE_CONFLICT_ROWS(2) }),
  },
  {
    id: "assign-team-without-members",
    action: "affecterEquipe",
    title: "équipe sans membres : ni requête employés, ni createMany",
    session: "admin",
    form: ASSIGN_FORM_3D,
    db: assignDb({ "team.findFirst": () => TEAM_ROW({ members: [] }) }),
  },
  {
    id: "assign-worksite-already-in-progress",
    action: "affecterEquipe",
    title: "chantier déjà IN_PROGRESS : pas de mise à jour de statut",
    session: "admin",
    form: ASSIGN_FORM_3D,
    db: assignDb({ "worksite.findFirst": () => WORKSITE_ROW({ status: "IN_PROGRESS" }) }),
  },
  {
    id: "assign-leader-without-userid",
    action: "affecterEquipe",
    title: "chef sans userId : ni notification, ni e-mail",
    session: "admin",
    form: ASSIGN_FORM_3D,
    db: assignDb({ "team.findFirst": () => TEAM_ROW({ leader: { userId: null } }) }),
  },
  {
    id: "assign-no-leader",
    action: "affecterEquipe",
    title: "équipe sans chef : ni notification, ni e-mail",
    session: "admin",
    form: ASSIGN_FORM_3D,
    db: assignDb({ "team.findFirst": () => TEAM_ROW({ leader: null }) }),
  },
  {
    id: "assign-leader-user-without-email",
    action: "affecterEquipe",
    title: "utilisateur du chef sans e-mail : notification, pas d'e-mail ni de lecture d'entreprise",
    session: "admin",
    form: ASSIGN_FORM_3D,
    db: assignDb({ "user.findUnique": () => ({ email: null, name: "Chef Nord" }) }),
  },
  {
    id: "assign-leader-user-without-name",
    action: "affecterEquipe",
    title: "utilisateur du chef sans nom : teamLeaderName = e-mail",
    session: "admin",
    form: ASSIGN_FORM_3D,
    db: assignDb({ "user.findUnique": () => ({ email: "chef.nord@example.test", name: null }) }),
  },
  {
    id: "assign-leader-user-not-found",
    action: "affecterEquipe",
    title: "utilisateur du chef introuvable : pas d'e-mail",
    session: "admin",
    form: ASSIGN_FORM_3D,
    db: assignDb({ "user.findUnique": () => null }),
  },
  {
    id: "assign-company-not-found",
    action: "affecterEquipe",
    title: "entreprise introuvable : companyName vide dans l'e-mail",
    session: "admin",
    form: ASSIGN_FORM_3D,
    db: assignDb({ "company.findUnique": () => null }),
  },
  {
    id: "assign-email-rejects",
    action: "affecterEquipe",
    title: "promesse d'e-mail rejetée : absorbée par .catch, succès inchangé",
    session: "admin",
    form: ASSIGN_FORM_3D,
    email: "reject",
    db: assignDb(),
  },
  {
    id: "assign-tx-error-assignment-create",
    action: "affecterEquipe",
    title: "erreur injectée dans assignment.create (2e jour) ⇒ rollback, message générique, console.error",
    session: "admin",
    form: ASSIGN_FORM_3D,
    db: assignDb({
      "assignment.create": (_args, nth) => {
        if (nth === 2) throw new Error("[double] unique constraint failed (P2002)")
        return { id: `assignment-${nth}` }
      },
    }),
  },
  {
    id: "assign-tx-error-notification-create",
    action: "affecterEquipe",
    title: "erreur injectée dans notification.create ⇒ rollback après les créations",
    session: "admin",
    form: ASSIGN_FORM_3D,
    db: assignDb({
      "notification.create": () => {
        throw new Error("[double] notification insert failed")
      },
    }),
  },
  {
    id: "assign-tx-error-non-error-value",
    action: "affecterEquipe",
    title: "valeur non-Error levée dans la transaction (String(err))",
    session: "admin",
    form: ASSIGN_FORM_3D,
    db: assignDb({
      "worksite.update": () => {
        // eslint-disable-next-line no-throw-literal
        throw "panne-texte"
      },
    }),
  },
  // ---- T-CORE-3 : auth/autorisation d'affecterEquipe ------------------------------------------
  {
    id: "assign-auth-session-absent",
    action: "affecterEquipe",
    title: "session absente ⇒ exception, trace Prisma vide",
    session: "none",
    form: ASSIGN_FORM_3D,
  },
  {
    id: "assign-auth-role-employee",
    action: "affecterEquipe",
    title: "rôle EMPLOYEE ⇒ exception, trace Prisma vide",
    session: "employee",
    form: ASSIGN_FORM_3D,
  },
  {
    id: "assign-auth-no-company",
    action: "affecterEquipe",
    title: "companyId absent ⇒ exception, trace Prisma vide",
    session: "noCompany",
    form: ASSIGN_FORM_3D,
  },
]

/** Identifiants uniques — vérifié au chargement. */
{
  const seen = new Set<string>()
  for (const c of CASES) {
    if (seen.has(c.id)) throw new Error(`[harness] identifiant de cas dupliqué : ${c.id}`)
    seen.add(c.id)
  }
}
