process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import type { Role } from "@prisma/client"
import {
  convertImportDraftActionImpl,
  type AcquisitionConversionActionDeps,
} from "@/lib/actions/acquisition-conversion.actions.core"

function session(role: Role, companyId: string | null = "co1") {
  return async () => ({ user: { id: "u1", role, companyId } })
}

function baseDeps(over: AcquisitionConversionActionDeps = {}): AcquisitionConversionActionDeps {
  return {
    auth: session("ADMIN"),
    isConversionEnabled: () => true,
    revalidatePath: () => {},
    ...over,
  }
}

describe("acquisition-conversion.actions", () => {
  it("session absente → FORBIDDEN", async () => {
    const r = await convertImportDraftActionImpl({}, baseDeps({ auth: async () => null }))
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "FORBIDDEN")
  })

  it("EMPLOYEE → FORBIDDEN", async () => {
    const r = await convertImportDraftActionImpl(
      {},
      baseDeps({ auth: session("EMPLOYEE") })
    )
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "FORBIDDEN")
  })

  it("flags OFF → DISABLED avant service", async () => {
    let called = false
    const r = await convertImportDraftActionImpl(
      { draftId: "d1" },
      baseDeps({
        isConversionEnabled: () => false,
        convertImportDraft: async () => {
          called = true
          return {
            ok: true,
            outcome: "CONVERTED",
            worksiteId: "w",
            clientId: "c",
            clientCreated: false,
            documentCount: 0,
            skippedAttachmentCount: 0,
          }
        },
      })
    )
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "DISABLED")
    assert.equal(called, false)
  })

  it("succès EXISTING → revalidate sans /clients", async () => {
    const paths: string[] = []
    let seenCompany: string | undefined
    const r = await convertImportDraftActionImpl(
      {
        draftId: "d9",
        expectedVersion: 1,
        clientMode: "EXISTING",
        existingClientId: "c1",
      },
      baseDeps({
        revalidatePath: (p) => paths.push(p),
        convertImportDraft: async (ctx) => {
          seenCompany = ctx.companyId
          return {
            ok: true,
            outcome: "CONVERTED",
            worksiteId: "w9",
            clientId: "c1",
            clientCreated: false,
            documentCount: 2,
            skippedAttachmentCount: 1,
          }
        },
      })
    )
    assert.equal(r.ok, true)
    assert.equal(seenCompany, "co1")
    assert.deepEqual(paths, [
      "/consultations",
      "/consultations/d9",
      "/chantiers",
      "/chantiers/w9",
    ])
  })

  it("succès NEW → revalidate inclut /clients", async () => {
    const paths: string[] = []
    const r = await convertImportDraftActionImpl(
      {
        draftId: "d9",
        expectedVersion: 1,
        clientMode: "NEW",
        newClient: { name: "Acme", email: null, phone: null, address: null },
      },
      baseDeps({
        revalidatePath: (p) => paths.push(p),
        convertImportDraft: async () => ({
          ok: true,
          outcome: "CONVERTED",
          worksiteId: "w9",
          clientId: "c-new",
          clientCreated: true,
          documentCount: 0,
          skippedAttachmentCount: 0,
        }),
      })
    )
    assert.equal(r.ok, true)
    assert.deepEqual(paths, [
      "/consultations",
      "/consultations/d9",
      "/chantiers",
      "/chantiers/w9",
      "/clients",
    ])
  })

  it("ALREADY_CONVERTED sans clientCreated → pas de /clients", async () => {
    const paths: string[] = []
    await convertImportDraftActionImpl(
      {
        draftId: "d9",
        expectedVersion: 1,
        clientMode: "EXISTING",
        existingClientId: "c1",
      },
      baseDeps({
        revalidatePath: (p) => paths.push(p),
        convertImportDraft: async () => ({
          ok: true,
          outcome: "ALREADY_CONVERTED",
          worksiteId: "w9",
          clientId: "c1",
          clientCreated: false,
          documentCount: 1,
          skippedAttachmentCount: 0,
        }),
      })
    )
    assert.deepEqual(paths, [
      "/consultations",
      "/consultations/d9",
      "/chantiers",
      "/chantiers/w9",
    ])
  })

  it("échec → pas de revalidate", async () => {
    const paths: string[] = []
    await convertImportDraftActionImpl(
      { draftId: "d1" },
      baseDeps({
        revalidatePath: (p) => paths.push(p),
        convertImportDraft: async () => ({
          ok: false,
          outcome: "STATE_CHANGED",
          code: "STATE_CHANGED",
          message: "obsolète",
        }),
      })
    )
    assert.deepEqual(paths, [])
  })
})

describe("acquisition-conversion flags env", () => {
  const env = { ...process.env }
  beforeEach(() => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONVERSION_ENABLED = "true"
  })
  afterEach(() => {
    process.env = { ...env }
  })

  it("master OFF bloque même si conversion ON", async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "false"
    const { isAcquisitionConversionFullyEnabled } = await import(
      "@/lib/acquisition/conversion/conversion-feature-flag"
    )
    assert.equal(isAcquisitionConversionFullyEnabled(), false)
  })
})
