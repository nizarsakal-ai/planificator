/**
 * Gardes serveur des pages V3 « Importer des adresses » et « Tournées » (aucune DB, aucun réseau, aucun fournisseur).
 * Patron : mock.module + import dynamique (cf. tests/employes/invitation-superadmin.action.test.ts).
 * Doubles : `@/auth` (session) et `@/lib/prisma` (double mémoire V2 du dépôt). Les vraies pages, l'autorité V2
 * (`authorizeVehicleLocked`), `preauthorizeImport` et `notFound()` de Next sont exercés tels quels.
 * Exécution : npm run test:vehicules:v3:pages (drapeau --experimental-test-module-mocks requis)
 */
import assert from "node:assert/strict"
import { afterEach, before, beforeEach, describe, it, mock } from "node:test"
import React from "react"
import type { MileageSession } from "@/lib/vehicules/mileage-access"
import { ADMIN, COMPANY, LEADER, MileageMemoryDb, NEXT_LEADER, TRUCK } from "../mileage-test-db"

// tsconfig "jsx": "preserve" → sous tsx, le JSX des pages est compilé en React.createElement (runtime classique).
;(globalThis as { React?: typeof React }).React = React

const FLAG = "PLANIFICATOR_VEHICLES_V3_ENABLED"
const OTHER_TRUCK = "truck-b"
const OTHER_ADMIN: MileageSession = { user: { id: "admin-b", role: "ADMIN", companyId: "company-b" } }
const EMPLOYEE: MileageSession = { user: { id: "employee", role: "EMPLOYEE", companyId: COMPANY } }

const state: { session: MileageSession | null; db: MileageMemoryDb; authCalls: number } = { session: null, db: new MileageMemoryDb(), authCalls: 0 }
const prismaDouble = { $transaction: (fn: unknown, options?: unknown) => (state.db.$transaction as (f: unknown, o?: unknown) => Promise<unknown>)(fn, options) }

type Element = { type: unknown; props: Record<string, unknown> }
type ImportsPage = (args: { params: Promise<{ id: string }> }) => Promise<Element>
type TourQuery = { importId?: string | string[]; revision?: string | string[] }
type TourPage = (args: { params: Promise<{ id: string }>; searchParams: Promise<TourQuery> }) => Promise<Element>
let importsPage: ImportsPage
let tourPage: TourPage
let VehicleImportsPanel: unknown
let TourPanel: unknown

before(async () => {
  mock.module("@/auth", { namedExports: { auth: async () => { state.authCalls++; return state.session } } })
  mock.module("@/lib/prisma", { namedExports: { prisma: prismaDouble } })
  importsPage = (await import("@/app/(dashboard)/vehicules/[id]/imports/page")).default as unknown as ImportsPage
  tourPage = (await import("@/app/(dashboard)/vehicules/[id]/tournees/page")).default as unknown as TourPage
  VehicleImportsPanel = (await import("@/components/vehicules/v3/VehicleImportsPanel")).VehicleImportsPanel
  TourPanel = (await import("@/components/vehicules/TourPanel")).TourPanel
})

const previousFlag = process.env[FLAG]
beforeEach(() => { process.env[FLAG] = "true"; state.session = ADMIN; state.db = new MileageMemoryDb(); state.authCalls = 0 })
afterEach(() => { if (previousFlag === undefined) delete process.env[FLAG]; else process.env[FLAG] = previousFlag })

const imports = (id = TRUCK) => importsPage({ params: Promise.resolve({ id }) })
const tours = (id = TRUCK, query: TourQuery = {}) => tourPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(query) })
const isNotFound = (error: unknown) => typeof error === "object" && error !== null && (error as { digest?: unknown }).digest === "NEXT_HTTP_ERROR_FALLBACK;404"
const dbTouched = () => state.db.calls.length > 0
const committed = () => state.db.calls.some(call => call.operation === "transaction.commit")

describe("Pages V3 Imports et Tournées — gardes serveur avant rendu", () => {
  it("drapeau absent : notFound sans session ni base", async () => {
    delete process.env[FLAG]
    await assert.rejects(imports(), isNotFound)
    await assert.rejects(tours(), isNotFound)
    assert.equal(state.authCalls, 0)
    assert.equal(dbTouched(), false)
  })

  it("administrateur de l'entreprise : les deux panneaux sont rendus pour le camion demandé", async () => {
    const importsElement = await imports()
    assert.equal(importsElement.type, VehicleImportsPanel)
    assert.deepEqual(importsElement.props, { truckId: TRUCK, routingEnabled: false })
    assert.equal(committed(), true)
    state.db = new MileageMemoryDb()
    const tourElement = await tours()
    assert.equal(tourElement.type, TourPanel)
    assert.equal(tourElement.props.truckId, TRUCK)
    assert.equal(committed(), true)
  })

  it("chef de l'équipe affectée : Tournées autorisée, Imports refusée avant toute base", async () => {
    state.session = LEADER
    const tourElement = await tours()
    assert.equal(tourElement.type, TourPanel)
    state.db = new MileageMemoryDb()
    await assert.rejects(imports(), isNotFound)
    assert.equal(dbTouched(), false, "le rôle est refusé avant la transaction")
  })

  it("chef non affecté : refus des deux pages, rien de validé", async () => {
    state.session = NEXT_LEADER
    await assert.rejects(tours(), isNotFound)
    await assert.rejects(imports(), isNotFound)
    assert.equal(committed(), false)
  })

  it("employé : refus des deux pages sans accès base", async () => {
    state.session = EMPLOYEE
    await assert.rejects(tours(), isNotFound)
    await assert.rejects(imports(), isNotFound)
    assert.equal(dbTouched(), false)
  })

  it("session absente : refus des deux pages sans accès base", async () => {
    state.session = null
    await assert.rejects(tours(), isNotFound)
    await assert.rejects(imports(), isNotFound)
    assert.equal(dbTouched(), false)
  })

  it("isolation inter-entreprises : administrateur d'une autre entreprise et camion d'une autre entreprise refusés", async () => {
    state.session = OTHER_ADMIN
    await assert.rejects(tours(), isNotFound)
    await assert.rejects(imports(), isNotFound)
    state.session = ADMIN
    await assert.rejects(tours(OTHER_TRUCK), isNotFound)
    await assert.rejects(imports(OTHER_TRUCK), isNotFound)
    assert.equal(committed(), false)
  })

  it("erreur base inattendue : relancée telle quelle, jamais convertie en notFound", async () => {
    state.db.failOnce = { operation: "truck.findFirst", error: new Error("DB_UNAVAILABLE") }
    await assert.rejects(tours(), (error: unknown) => error instanceof Error && error.message === "DB_UNAVAILABLE" && !isNotFound(error))
    state.db.failOnce = { operation: "truck.findFirst", error: new Error("DB_UNAVAILABLE") }
    await assert.rejects(imports(), (error: unknown) => error instanceof Error && error.message === "DB_UNAVAILABLE" && !isNotFound(error))
  })

  it("Tournées : lecture des paramètres d'import préservée", async () => {
    const cases: [TourQuery, Record<string, unknown>][] = [
      [{}, { importId: undefined, importRevision: undefined, importRequested: false }],
      [{ importId: "import-1", revision: "3" }, { importId: "import-1", importRevision: 3, importRequested: true }],
      [{ importId: ["a", "b"], revision: "x" }, { importId: undefined, importRevision: undefined, importRequested: true }],
      [{ revision: "0" }, { importId: undefined, importRevision: 0, importRequested: true }],
    ]
    for (const [query, expected] of cases) {
      const element = await tours(TRUCK, query)
      assert.deepEqual(element.props, { truckId: TRUCK, ...expected })
    }
  })
})
