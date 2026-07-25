/**
 * PLAN-ACQ-012-LOT-1.5 — Tests AcquisitionPartnerAdminService.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  AcquisitionPartnerAdminService,
  type PartnerAdminDb,
} from "@/lib/acquisition/admin/partner-admin.service"
import {
  DomainAlreadyExistsError,
  DomainNotFoundError,
  InvalidDomainError,
  InvalidPartnerCodeError,
  InvalidPartnerNameError,
  PartnerAdminPersistenceError,
  PartnerAlreadyExistsError,
  PartnerNotFoundError,
} from "@/lib/acquisition/admin/partner-admin.errors"
import { domainInputSchema } from "@/lib/acquisition/admin/partner-admin.schema"
import type {
  PartnerAdminDomain,
  PartnerAdminPartner,
} from "@/lib/acquisition/admin/partner-admin.types"

type Store = {
  partners: PartnerAdminPartner[]
  domains: PartnerAdminDomain[]
  deletes: number
}

function cloneStore(s: Store): Store {
  return {
    partners: s.partners.map((p) => ({ ...p })),
    domains: s.domains.map((d) => ({ ...d })),
    deletes: s.deletes,
  }
}

function p2002(): Error & { code: string } {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
}

function createFakeDb(
  seed: Partial<Store> = {},
  options: {
    /** Écrit le domaine puis échoue → prouve le rollback TX. */
    failAfterDomainWrite?: boolean
    throwP2002OnPartnerCreate?: boolean
    throwP2002OnDomainCreate?: boolean
    /** Erreur Prisma non-P2002 (ex. P2024). */
    throwUnknownPrismaOnDomainCreate?: boolean
  } = {}
): { db: PartnerAdminDb; store: Store } {
  const store: Store = {
    partners: seed.partners ? seed.partners.map((p) => ({ ...p })) : [],
    domains: seed.domains ? seed.domains.map((d) => ({ ...d })) : [],
    deletes: 0,
  }

  let seq = 0
  const nextId = (prefix: string) => `${prefix}_${++seq}`

  function bind(active: Store): PartnerAdminDb {
    return {
      acquisitionPartner: {
        findUnique: async (args: unknown) => {
          const where = (args as { where: { companyId_code?: { companyId: string; code: string } } })
            .where
          if (where.companyId_code) {
            return (
              active.partners.find(
                (p) =>
                  p.companyId === where.companyId_code!.companyId &&
                  p.code === where.companyId_code!.code
              ) ?? null
            )
          }
          return null
        },
        findFirst: async (args: unknown) => {
          const where = (args as { where: { id?: string; companyId?: string } }).where
          return (
            active.partners.find(
              (p) =>
                (where.id === undefined || p.id === where.id) &&
                (where.companyId === undefined || p.companyId === where.companyId)
            ) ?? null
          )
        },
        create: async (args: unknown) => {
          if (options.throwP2002OnPartnerCreate) throw p2002()
          const data = (args as { data: Omit<PartnerAdminPartner, "id" | "createdAt" | "updatedAt"> })
            .data
          if (
            active.partners.some(
              (p) => p.companyId === data.companyId && p.code === data.code
            )
          ) {
            throw p2002()
          }
          const now = new Date()
          const row: PartnerAdminPartner = {
            id: nextId("p"),
            companyId: data.companyId,
            name: data.name,
            code: data.code,
            connector: data.connector,
            pipeline: data.pipeline,
            active: data.active,
            createdAt: now,
            updatedAt: now,
          }
          active.partners.push(row)
          return { ...row }
        },
        updateMany: async (args: unknown) => {
          const { where, data } = args as {
            where: { id: string; companyId: string }
            data: Partial<PartnerAdminPartner>
          }
          let count = 0
          for (const p of active.partners) {
            if (p.id === where.id && p.companyId === where.companyId) {
              Object.assign(p, data, { updatedAt: new Date() })
              count += 1
            }
          }
          return { count }
        },
      },
      acquisitionPartnerDomain: {
        findUnique: async (args: unknown) => {
          const where = (
            args as {
              where: {
                companyId_domainNormalized?: {
                  companyId: string
                  domainNormalized: string
                }
              }
            }
          ).where
          if (where.companyId_domainNormalized) {
            const key = where.companyId_domainNormalized
            return (
              active.domains.find(
                (d) =>
                  d.companyId === key.companyId &&
                  d.domainNormalized === key.domainNormalized
              ) ?? null
            )
          }
          return null
        },
        findFirst: async (args: unknown) => {
          const where = (args as { where: { id?: string; companyId?: string } }).where
          return (
            active.domains.find(
              (d) =>
                (where.id === undefined || d.id === where.id) &&
                (where.companyId === undefined || d.companyId === where.companyId)
            ) ?? null
          )
        },
        create: async (args: unknown) => {
          if (options.throwP2002OnDomainCreate) throw p2002()
          if (options.throwUnknownPrismaOnDomainCreate) {
            throw Object.assign(new Error("raw prisma timeout secret"), {
              code: "P2024",
            })
          }
          const data = (
            args as {
              data: Omit<PartnerAdminDomain, "id" | "createdAt" | "updatedAt">
            }
          ).data
          if (
            active.domains.some(
              (d) =>
                d.companyId === data.companyId &&
                d.domainNormalized === data.domainNormalized
            )
          ) {
            throw p2002()
          }
          const now = new Date()
          const row: PartnerAdminDomain = {
            id: nextId("d"),
            companyId: data.companyId,
            partnerId: data.partnerId,
            domainNormalized: data.domainNormalized,
            active: data.active,
            createdAt: now,
            updatedAt: now,
          }
          // Écriture partielle d’abord — puis échec optionnel (rollback TX).
          active.domains.push(row)
          if (options.failAfterDomainWrite) {
            throw new Error("simulated failure after domain write")
          }
          return { ...row }
        },
        updateMany: async (args: unknown) => {
          const { where, data } = args as {
            where: { id: string; companyId: string }
            data: Partial<PartnerAdminDomain>
          }
          let count = 0
          for (const d of active.domains) {
            if (d.id === where.id && d.companyId === where.companyId) {
              Object.assign(d, data, { updatedAt: new Date() })
              count += 1
            }
          }
          return { count }
        },
      },
      $transaction: async <T>(fn: (tx: PartnerAdminDb) => Promise<T>): Promise<T> => {
        const snapshot = cloneStore(active)
        const txStore: Store = {
          partners: active.partners,
          domains: active.domains,
          deletes: active.deletes,
        }
        // Bind tx to same arrays; on failure restore snapshot (rollback).
        const tx = bind(txStore)
        try {
          const result = await fn(tx)
          return result
        } catch (e) {
          active.partners.splice(0, active.partners.length, ...snapshot.partners)
          active.domains.splice(0, active.domains.length, ...snapshot.domains)
          active.deletes = snapshot.deletes
          throw e
        }
      },
    }
  }

  // Patch bind to track delete attempts if any API added later
  const db = bind(store)
  const originalPartner = db.acquisitionPartner
  ;(db as PartnerAdminDb & { __store: Store }).__store = store

  // Guarantees: no delete API on the surface
  assert.equal("delete" in originalPartner, false)
  assert.equal("deleteMany" in originalPartner, false)
  assert.equal("delete" in db.acquisitionPartnerDomain, false)

  return { db, store }
}

describe("AcquisitionPartnerAdminService", () => {
  it("crée un partenaire (code normalisé lowercase)", async () => {
    const { db, store } = createFakeDb()
    const svc = new AcquisitionPartnerAdminService({ db })
    const p = await svc.createPartner({
      companyId: "co_a",
      name: "  Acme  ",
      code: "  AcMe  ",
    })
    assert.equal(p.code, "acme")
    assert.equal(p.name, "Acme")
    assert.equal(p.active, true)
    assert.equal(p.connector, "GMAIL")
    assert.equal(p.pipeline, "consultations")
    assert.equal(store.partners.length, 1)
  })

  it("crée un domaine (trim + lowercase)", async () => {
    const { db, store } = createFakeDb({
      partners: [
        {
          id: "p1",
          companyId: "co_a",
          name: "Acme",
          code: "acme",
          connector: "GMAIL",
          pipeline: "consultations",
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    })
    const svc = new AcquisitionPartnerAdminService({ db })
    const d = await svc.addDomain({
      companyId: "co_a",
      partnerId: "p1",
      domain: "  Mail.Acme.FR ",
    })
    assert.equal(d.domainNormalized, "mail.acme.fr")
    assert.equal(d.partnerId, "p1")
    assert.equal(store.domains.length, 1)
  })

  it("refuse doublon partenaire", async () => {
    const { db } = createFakeDb({
      partners: [
        {
          id: "p1",
          companyId: "co_a",
          name: "Acme",
          code: "acme",
          connector: "GMAIL",
          pipeline: "consultations",
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    })
    const svc = new AcquisitionPartnerAdminService({ db })
    await assert.rejects(
      () => svc.createPartner({ companyId: "co_a", name: "Other", code: "acme" }),
      (e: unknown) => e instanceof PartnerAlreadyExistsError
    )
  })

  it("refuse doublon domaine", async () => {
    const { db } = createFakeDb({
      partners: [
        {
          id: "p1",
          companyId: "co_a",
          name: "Acme",
          code: "acme",
          connector: "GMAIL",
          pipeline: "consultations",
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      domains: [
        {
          id: "d1",
          companyId: "co_a",
          partnerId: "p1",
          domainNormalized: "acme.fr",
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    })
    const svc = new AcquisitionPartnerAdminService({ db })
    await assert.rejects(
      () =>
        svc.addDomain({ companyId: "co_a", partnerId: "p1", domain: "ACME.FR" }),
      (e: unknown) => e instanceof DomainAlreadyExistsError
    )
  })

  it("mappe P2002 create partenaire → PartnerAlreadyExistsError", async () => {
    const { db } = createFakeDb({}, { throwP2002OnPartnerCreate: true })
    const svc = new AcquisitionPartnerAdminService({ db })
    await assert.rejects(
      () => svc.createPartner({ companyId: "co_a", name: "X", code: "x" }),
      (e: unknown) => e instanceof PartnerAlreadyExistsError
    )
  })

  it("active / désactive un partenaire", async () => {
    const { db } = createFakeDb({
      partners: [
        {
          id: "p1",
          companyId: "co_a",
          name: "Acme",
          code: "acme",
          connector: "GMAIL",
          pipeline: "consultations",
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    })
    const svc = new AcquisitionPartnerAdminService({ db })
    const off = await svc.deactivatePartner({ companyId: "co_a", partnerId: "p1" })
    assert.equal(off.active, false)
    const on = await svc.activatePartner({ companyId: "co_a", partnerId: "p1" })
    assert.equal(on.active, true)
  })

  it("active / désactive un domaine", async () => {
    const { db } = createFakeDb({
      partners: [
        {
          id: "p1",
          companyId: "co_a",
          name: "Acme",
          code: "acme",
          connector: "GMAIL",
          pipeline: "consultations",
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      domains: [
        {
          id: "d1",
          companyId: "co_a",
          partnerId: "p1",
          domainNormalized: "acme.fr",
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    })
    const svc = new AcquisitionPartnerAdminService({ db })
    const off = await svc.deactivateDomain({ companyId: "co_a", domainId: "d1" })
    assert.equal(off.active, false)
    const on = await svc.activateDomain({ companyId: "co_a", domainId: "d1" })
    assert.equal(on.active, true)
  })

  it("renomme un partenaire", async () => {
    const { db } = createFakeDb({
      partners: [
        {
          id: "p1",
          companyId: "co_a",
          name: "Old",
          code: "acme",
          connector: "GMAIL",
          pipeline: "consultations",
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    })
    const svc = new AcquisitionPartnerAdminService({ db })
    const p = await svc.renamePartner({
      companyId: "co_a",
      partnerId: "p1",
      name: "  New Name  ",
    })
    assert.equal(p.name, "New Name")
    assert.equal(p.code, "acme")
  })

  it("refuse code / domaine / nom vides ou invalides", async () => {
    const { db } = createFakeDb()
    const svc = new AcquisitionPartnerAdminService({ db })
    await assert.rejects(
      () => svc.createPartner({ companyId: "co_a", name: "X", code: "   " }),
      (e: unknown) => e instanceof InvalidPartnerCodeError
    )
    await assert.rejects(
      () => svc.createPartner({ companyId: "co_a", name: "   ", code: "ok" }),
      (e: unknown) => e instanceof InvalidPartnerNameError
    )
    await assert.rejects(
      () =>
        svc.addDomain({
          companyId: "co_a",
          partnerId: "p1",
          domain: "   ",
        }),
      (e: unknown) => e instanceof InvalidDomainError
    )
    await assert.rejects(
      () =>
        svc.addDomain({
          companyId: "co_a",
          partnerId: "p1",
          domain: "not a domain",
        }),
      (e: unknown) => e instanceof InvalidDomainError
    )
  })

  it("isolation multi-tenant : partenaire d’un autre tenant introuvable", async () => {
    const { db, store } = createFakeDb({
      partners: [
        {
          id: "p1",
          companyId: "co_a",
          name: "Acme",
          code: "acme",
          connector: "GMAIL",
          pipeline: "consultations",
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    })
    const svc = new AcquisitionPartnerAdminService({ db })
    await assert.rejects(
      () => svc.deactivatePartner({ companyId: "co_b", partnerId: "p1" }),
      (e: unknown) => e instanceof PartnerNotFoundError
    )
    await assert.rejects(
      () =>
        svc.addDomain({ companyId: "co_b", partnerId: "p1", domain: "acme.fr" }),
      (e: unknown) => e instanceof PartnerNotFoundError
    )
    assert.equal(store.domains.length, 0)
    assert.equal(store.partners[0]?.active, true)
  })

  it("transaction rollback : écriture partielle domaine annulée après échec", async () => {
    const { db, store } = createFakeDb(
      {
        partners: [
          {
            id: "p1",
            companyId: "co_a",
            name: "Acme",
            code: "acme",
            connector: "GMAIL",
            pipeline: "consultations",
            active: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      },
      { failAfterDomainWrite: true }
    )
    const svc = new AcquisitionPartnerAdminService({ db })
    await assert.rejects(() =>
      svc.addDomain({ companyId: "co_a", partnerId: "p1", domain: "acme.fr" })
    )
    // Le fake a poussé le domaine puis a throw — le rollback TX doit restaurer.
    assert.equal(store.domains.length, 0, "rollback après écriture partielle")
    assert.equal(store.partners.length, 1)
  })

  it("P2002 création domaine → DomainAlreadyExistsError", async () => {
    const { db, store } = createFakeDb(
      {
        partners: [
          {
            id: "p1",
            companyId: "co_a",
            name: "Acme",
            code: "acme",
            connector: "GMAIL",
            pipeline: "consultations",
            active: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      },
      { throwP2002OnDomainCreate: true }
    )
    const svc = new AcquisitionPartnerAdminService({ db })
    await assert.rejects(
      () =>
        svc.addDomain({ companyId: "co_a", partnerId: "p1", domain: "acme.fr" }),
      (e: unknown) => e instanceof DomainAlreadyExistsError
    )
    assert.equal(store.domains.length, 0)
  })

  it("erreur Prisma inconnue → PartnerAdminPersistenceError (sans fuite)", async () => {
    const { db } = createFakeDb(
      {
        partners: [
          {
            id: "p1",
            companyId: "co_a",
            name: "Acme",
            code: "acme",
            connector: "GMAIL",
            pipeline: "consultations",
            active: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      },
      { throwUnknownPrismaOnDomainCreate: true }
    )
    const svc = new AcquisitionPartnerAdminService({ db })
    await assert.rejects(
      () =>
        svc.addDomain({ companyId: "co_a", partnerId: "p1", domain: "acme.fr" }),
      (e: unknown) => {
        assert.ok(e instanceof PartnerAdminPersistenceError)
        assert.equal(e.code, "PERSISTENCE_ERROR")
        assert.equal(String(e.message).includes("secret"), false)
        assert.equal(String(e.message).includes("P2024"), false)
        return true
      }
    )
  })

  it("activation déjà active / désactivation déjà inactive = succès idempotent", async () => {
    const { db, store } = createFakeDb({
      partners: [
        {
          id: "p1",
          companyId: "co_a",
          name: "Acme",
          code: "acme",
          connector: "GMAIL",
          pipeline: "consultations",
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "p2",
          companyId: "co_a",
          name: "Beta",
          code: "beta",
          connector: "GMAIL",
          pipeline: "consultations",
          active: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      domains: [
        {
          id: "d1",
          companyId: "co_a",
          partnerId: "p1",
          domainNormalized: "acme.fr",
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "d2",
          companyId: "co_a",
          partnerId: "p2",
          domainNormalized: "beta.fr",
          active: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    })
    const svc = new AcquisitionPartnerAdminService({ db })
    const pOn = await svc.activatePartner({ companyId: "co_a", partnerId: "p1" })
    assert.equal(pOn.active, true)
    const pOff = await svc.deactivatePartner({ companyId: "co_a", partnerId: "p2" })
    assert.equal(pOff.active, false)
    const dOn = await svc.activateDomain({ companyId: "co_a", domainId: "d1" })
    assert.equal(dOn.active, true)
    const dOff = await svc.deactivateDomain({ companyId: "co_a", domainId: "d2" })
    assert.equal(dOff.active, false)
    assert.equal(store.partners.find((p) => p.id === "p1")?.active, true)
    assert.equal(store.partners.find((p) => p.id === "p2")?.active, false)
  })

  it("domaine d’un autre tenant (ID valide) → DomainNotFoundError", async () => {
    const { db, store } = createFakeDb({
      partners: [
        {
          id: "p1",
          companyId: "co_a",
          name: "Acme",
          code: "acme",
          connector: "GMAIL",
          pipeline: "consultations",
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      domains: [
        {
          id: "d1",
          companyId: "co_a",
          partnerId: "p1",
          domainNormalized: "acme.fr",
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    })
    const svc = new AcquisitionPartnerAdminService({ db })
    await assert.rejects(
      () => svc.deactivateDomain({ companyId: "co_b", domainId: "d1" }),
      (e: unknown) => e instanceof DomainNotFoundError
    )
    await assert.rejects(
      () => svc.activateDomain({ companyId: "co_b", domainId: "d1" }),
      (e: unknown) => e instanceof DomainNotFoundError
    )
    assert.equal(store.domains[0]?.active, true)
    assert.equal(store.domains[0]?.companyId, "co_a")
  })

  it("matrice formats domaine : trim/lowercase uniquement, refus non-domaine", () => {
    const accepted: Array<[string, string]> = [
      ["example.com", "example.com"],
      [" EXAMPLE.COM ", "example.com"],
      ["mail.acme.fr", "mail.acme.fr"],
    ]
    for (const [raw, expected] of accepted) {
      const r = domainInputSchema.safeParse(raw)
      assert.equal(r.success, true, `devrait accepter ${JSON.stringify(raw)}`)
      if (r.success) assert.equal(r.data, expected)
    }

    const rejected = [
      "@example.com",
      "https://example.com",
      "user@example.com",
      "example.com/path",
      "example",
      ".example.com",
      "example.com.",
      "",
      "   ",
    ]
    for (const raw of rejected) {
      const r = domainInputSchema.safeParse(raw)
      assert.equal(r.success, false, `devrait refuser ${JSON.stringify(raw)}`)
    }
  })

  it("erreurs métier : partenaire / domaine introuvables", async () => {
    const { db } = createFakeDb()
    const svc = new AcquisitionPartnerAdminService({ db })
    await assert.rejects(
      () => svc.activatePartner({ companyId: "co_a", partnerId: "missing" }),
      (e: unknown) => e instanceof PartnerNotFoundError
    )
    await assert.rejects(
      () => svc.activateDomain({ companyId: "co_a", domainId: "missing" }),
      (e: unknown) => e instanceof DomainNotFoundError
    )
  })

  it("aucune suppression physique : historique conservé après désactivation", async () => {
    const { db, store } = createFakeDb({
      partners: [
        {
          id: "p1",
          companyId: "co_a",
          name: "Acme",
          code: "acme",
          connector: "GMAIL",
          pipeline: "consultations",
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      domains: [
        {
          id: "d1",
          companyId: "co_a",
          partnerId: "p1",
          domainNormalized: "acme.fr",
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    })
    const svc = new AcquisitionPartnerAdminService({ db })
    await svc.deactivatePartner({ companyId: "co_a", partnerId: "p1" })
    await svc.deactivateDomain({ companyId: "co_a", domainId: "d1" })
    assert.equal(store.partners.length, 1)
    assert.equal(store.domains.length, 1)
    assert.equal(store.partners[0]?.active, false)
    assert.equal(store.domains[0]?.active, false)
    assert.equal(store.deletes, 0)
    assert.equal("delete" in db.acquisitionPartner, false)
    assert.equal("deleteMany" in db.acquisitionPartner, false)
    assert.equal("delete" in db.acquisitionPartnerDomain, false)
    assert.equal("deleteMany" in db.acquisitionPartnerDomain, false)
  })

  it("même code autorisé sur deux tenants", async () => {
    const { db, store } = createFakeDb()
    const svc = new AcquisitionPartnerAdminService({ db })
    await svc.createPartner({ companyId: "co_a", name: "A", code: "acme" })
    await svc.createPartner({ companyId: "co_b", name: "B", code: "acme" })
    assert.equal(store.partners.length, 2)
    assert.equal(store.partners[0]?.companyId, "co_a")
    assert.equal(store.partners[1]?.companyId, "co_b")
  })
})
