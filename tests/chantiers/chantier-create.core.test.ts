/**
 * LOT-1W-1a — T-CORE-1 (createWorksiteCore), T-CORE-3 (adaptateur createChantier), T-CORE-7 (fuseau).
 *
 * 1. Parité : chaque cas `createChantier` du harnais est rejoué contre adaptateur + cœur avec les
 *    MÊMES doubles de modules, la MÊME horloge figée et le MÊME `TZ` que la référence enregistrée
 *    sur BASE_SHA, puis comparé par égalité profonde (retour, trace ordonnée avec `inTx`, effets).
 *    Les références ne sont jamais régénérées ici : toute divergence est un défaut du refactor.
 * 2. Cœur seul : contrat `CoreResult` (codes, `details.message`), ports appelés ou non, propagation
 *    des exceptions (géocodage, `worksite.create`) telle qu'observée à BASE_SHA.
 *
 * Exécution : `TZ=<UTC|Europe/Paris> node --import tsx --experimental-test-module-mocks --test <fichier>`
 * (ligne `test:chantiers` de package.json).
 */

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { before, describe, it } from "node:test"
import {
  CASES,
  REFERENCE_DIR,
  SUPPORTED_TZ,
  loadActions,
  referenceFileName,
  runCase,
  stableJson,
  type ActionsModule,
  type CaseRecord,
} from "./parity/harness"
import { createWorksiteCore, type CreateWorksiteDeps, type CreateWorksiteInput } from "@/lib/actions/chantier-create.core"

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()
const TZ = process.env.TZ ?? ""

function readReference(caseId: string): CaseRecord {
  const path = join(ROOT, REFERENCE_DIR, referenceFileName(caseId, TZ))
  assert.ok(existsSync(path), `référence absente : ${path}`)
  return JSON.parse(readFileSync(path, "utf8")) as CaseRecord
}

// ---- 1. Parité contre la référence BASE_SHA -------------------------------------------------------

describe(`T-CORE-1/T-CORE-3 — parité createChantier (adaptateur + cœur) vs référence BASE_SHA [TZ=${TZ || "non défini"}]`, () => {
  let actions: ActionsModule
  before(async () => {
    assert.ok(SUPPORTED_TZ[TZ], `TZ doit valoir ${Object.keys(SUPPORTED_TZ).join(" ou ")} (reçu ${JSON.stringify(TZ)})`)
    assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, TZ, "fuseau effectif ≠ TZ")
    actions = await loadActions()
  })

  const createCases = CASES.filter((c) => c.action === "createChantier")
  assert.ok(createCases.length >= 20, "jeu de cas createChantier incomplet")

  for (const c of createCases) {
    it(`${c.id} — ${c.title}`, async () => {
      const reference = readReference(c.id)
      const replay = JSON.parse(stableJson(await runCase(actions, c))) as CaseRecord
      assert.deepEqual(replay.input, reference.input, "entrées du cas ≠ référence (définition du cas modifiée ?)")
      assert.deepEqual(replay.result, reference.result, "retour ≠ référence BASE_SHA")
      assert.deepEqual(replay.trace, reference.trace, "trace (appels, args, inTx, effets) ≠ référence BASE_SHA")
    })
  }

  it("T-CORE-3 (4bis) : session absente / EMPLOYEE / sans companyId ⇒ même exception, aucun appel Prisma, aucun effet (lu dans la référence)", () => {
    const expected: Record<string, string> = {
      "create-auth-session-absent": "Non authentifié",
      "create-auth-role-employee": "Accès refusé",
      "create-auth-no-company": "Entreprise introuvable",
    }
    for (const [id, message] of Object.entries(expected)) {
      const ref = readReference(id)
      assert.deepEqual(ref.result, { threw: { name: "Error", message } })
      assert.deepEqual(ref.trace.map((t) => t.kind), ["auth"])
    }
  })

  it("T-CORE-3 : exception du géocodage et erreur de worksite.create propagées, aucune revalidation (lu dans la référence)", () => {
    const geo = readReference("create-geocode-throws")
    assert.deepEqual(geo.result, { threw: { name: "Error", message: "[double] geocode boom" } })
    assert.ok(!geo.trace.some((t) => t.kind === "revalidatePath"))
    const create = readReference("create-worksite-create-throws")
    assert.deepEqual(create.result, { threw: { name: "Error", message: "[double] worksite.create failed (P2003)" } })
    assert.ok(!create.trace.some((t) => t.kind === "revalidatePath"))
  })
})

// ---- 2. Cœur seul ----------------------------------------------------------------------------------

type Call = { port: string; args: unknown }

function fakeDeps(over: Partial<{ client: object | null; geocode: "ok" | "null" | "throw"; createThrows: boolean }> = {}) {
  const calls: Call[] = []
  const deps: CreateWorksiteDeps = {
    findClient: async (args) => {
      calls.push({ port: "findClient", args })
      return over.client === undefined ? { id: "client-1" } : over.client
    },
    createWorksite: async (args) => {
      calls.push({ port: "createWorksite", args })
      if (over.createThrows) throw new Error("create failed")
      return { id: "worksite-new-1" }
    },
    geocode: async (address) => {
      calls.push({ port: "geocode", args: address })
      if (over.geocode === "throw") throw new Error("geocode boom")
      if (over.geocode === "null") return null
      return { latitude: 48.8566, longitude: 2.3522 }
    },
  }
  return { deps, calls }
}

const ACTOR = { companyId: "company-A", actorUserId: "user-admin-1" }
const INPUT: CreateWorksiteInput = {
  name: "Rénovation toiture",
  description: "",
  address: "12 rue des Lilas, 75020 Paris",
  clientId: "client-1",
  startDate: "2026-11-03",
  endDate: "2026-11-05",
  dailyHours: "8",
}

describe("T-CORE-1 — createWorksiteCore (cœur seul, dépendances en mémoire)", () => {
  it("Zod en échec ⇒ VALIDATION avec le message Zod ; aucun port appelé", async () => {
    const { deps, calls } = fakeDeps()
    const r = await createWorksiteCore({ ...INPUT, name: "" }, ACTOR, deps)
    assert.deepEqual(r, { ok: false, code: "VALIDATION", details: { message: "Le nom est requis" } })
    assert.deepEqual(calls, [])
  })

  it("endDate < startDate ⇒ VALIDATION « La date de fin doit être après la date de début »", async () => {
    const { deps } = fakeDeps()
    const r = await createWorksiteCore({ ...INPUT, startDate: "2026-11-05", endDate: "2026-11-03" }, ACTOR, deps)
    assert.deepEqual(r, { ok: false, code: "VALIDATION", details: { message: "La date de fin doit être après la date de début" } })
  })

  it("client introuvable ⇒ CLIENT_NOT_FOUND « Client introuvable. » ; ni géocodage ni création", async () => {
    const { deps, calls } = fakeDeps({ client: null })
    const r = await createWorksiteCore(INPUT, ACTOR, deps)
    assert.deepEqual(r, { ok: false, code: "CLIENT_NOT_FOUND", details: { message: "Client introuvable." } })
    assert.deepEqual(calls.map((c) => c.port), ["findClient"])
    assert.deepEqual(calls[0].args, { where: { id: "client-1", companyId: "company-A" } })
  })

  it("entrée valide avec adresse ⇒ géocodage puis création avec les mêmes champs ; data.worksiteId", async () => {
    const { deps, calls } = fakeDeps()
    const r = await createWorksiteCore(INPUT, ACTOR, deps)
    assert.deepEqual(r, { ok: true, data: { worksiteId: "worksite-new-1" } })
    assert.deepEqual(calls.map((c) => c.port), ["findClient", "geocode", "createWorksite"])
    assert.equal(calls[1].args, INPUT.address)
    assert.deepEqual(calls[2].args, {
      data: {
        name: "Rénovation toiture",
        description: null,
        address: "12 rue des Lilas, 75020 Paris",
        clientId: "client-1",
        companyId: "company-A",
        createdById: "user-admin-1",
        startDate: new Date("2026-11-03"),
        endDate: new Date("2026-11-05"),
        dailyHours: 8,
        status: "PLANNED",
        latitude: 48.8566,
        longitude: 2.3522,
      },
    })
  })

  it("sans adresse ⇒ aucun géocodage, latitude/longitude null ; géocodage null ⇒ idem", async () => {
    const a = fakeDeps()
    await createWorksiteCore({ ...INPUT, address: "" }, ACTOR, a.deps)
    assert.deepEqual(a.calls.map((c) => c.port), ["findClient", "createWorksite"])
    const dataA = (a.calls[1].args as { data: { address: unknown; latitude: unknown; longitude: unknown } }).data
    assert.deepEqual([dataA.address, dataA.latitude, dataA.longitude], [null, null, null])

    const b = fakeDeps({ geocode: "null" })
    await createWorksiteCore(INPUT, ACTOR, b.deps)
    const dataB = (b.calls[2].args as { data: { latitude: unknown; longitude: unknown } }).data
    assert.deepEqual([dataB.latitude, dataB.longitude], [null, null])
  })

  it("exception du géocodage et erreur de création : propagées (aucune nouvelle capture)", async () => {
    const g = fakeDeps({ geocode: "throw" })
    await assert.rejects(createWorksiteCore(INPUT, ACTOR, g.deps), { message: "geocode boom" })
    assert.deepEqual(g.calls.map((c) => c.port), ["findClient", "geocode"])
    const c = fakeDeps({ createThrows: true })
    await assert.rejects(createWorksiteCore(INPUT, ACTOR, c.deps), { message: "create failed" })
  })

  it("WriteActor : companyId ⇒ where.companyId et data.companyId ; actorUserId ⇒ data.createdById", async () => {
    const { deps, calls } = fakeDeps()
    await createWorksiteCore({ ...INPUT, address: "" }, { companyId: "company-Z", actorUserId: "user-z" }, deps)
    assert.deepEqual(calls[0].args, { where: { id: "client-1", companyId: "company-Z" } })
    const data = (calls[1].args as { data: { companyId: string; createdById: string } }).data
    assert.deepEqual([data.companyId, data.createdById], ["company-Z", "user-z"])
  })
})
