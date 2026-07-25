/**
 * PLAN-ACQ-012-LOT-1.5 — Service d’administration du registre partenaires.
 *
 * Couche distincte du runtime Acquisition : le runtime ne doit jamais importer
 * ce module. Aucune suppression physique — activation / désactivation uniquement.
 *
 * Écritures multi-étapes via `$transaction` interactive (pattern dépôt).
 * Erreurs Prisma mappées vers erreurs métier (jamais exposées telles quelles).
 *
 * ## Contrats
 *
 * ### Création (createPartner / addDomain)
 * Non idempotentes. Deux créations concurrentes identiques → une réussit,
 * l’autre lève `PartnerAlreadyExistsError` ou `DomainAlreadyExistsError`
 * (pré-check ou P2002 hors TX).
 *
 * ### Activation / désactivation
 * Volontairement idempotentes : activer déjà actif / désactiver déjà inactif
 * = succès, sans conflit d’état. Aucune réactivation implicite croisée
 * partenaire ↔ domaine.
 */
import type { AcquisitionSource } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { ZodError } from "zod"
import {
  addDomainSchema,
  createPartnerSchema,
  domainRefSchema,
  partnerRefSchema,
  renamePartnerSchema,
} from "@/lib/acquisition/admin/partner-admin.schema"
import {
  DomainAlreadyExistsError,
  DomainNotFoundError,
  InvalidDomainError,
  InvalidPartnerCodeError,
  InvalidPartnerNameError,
  isUniqueConstraintError,
  PartnerAdminPersistenceError,
  PartnerAlreadyExistsError,
  PartnerNotFoundError,
} from "@/lib/acquisition/admin/partner-admin.errors"
import type {
  AddDomainInput,
  CreatePartnerInput,
  DomainRefInput,
  PartnerAdminDomain,
  PartnerAdminPartner,
  PartnerRefInput,
  RenamePartnerInput,
} from "@/lib/acquisition/admin/partner-admin.types"

const DEFAULT_CONNECTOR: AcquisitionSource = "GMAIL"
const DEFAULT_PIPELINE = "consultations"

type PartnerRow = PartnerAdminPartner
type DomainRow = PartnerAdminDomain

/** Surface Prisma minimale pour tests / composition. */
export type PartnerAdminDb = {
  acquisitionPartner: {
    findFirst: (args: unknown) => Promise<PartnerRow | null>
    findUnique: (args: unknown) => Promise<PartnerRow | null>
    create: (args: unknown) => Promise<PartnerRow>
    updateMany: (args: unknown) => Promise<{ count: number }>
  }
  acquisitionPartnerDomain: {
    findFirst: (args: unknown) => Promise<DomainRow | null>
    findUnique: (args: unknown) => Promise<DomainRow | null>
    create: (args: unknown) => Promise<DomainRow>
    updateMany: (args: unknown) => Promise<{ count: number }>
  }
  $transaction: <T>(fn: (tx: PartnerAdminDb) => Promise<T>) => Promise<T>
}

export type AcquisitionPartnerAdminServiceDeps = {
  db?: PartnerAdminDb
}

function mapZodToBusiness(error: ZodError): never {
  const issue = error.issues[0]
  const path = issue?.path?.join(".") ?? ""
  const msg = issue?.message ?? "Entrée invalide"
  if (path.includes("domain") || msg.toLowerCase().includes("domaine")) {
    throw new InvalidDomainError(msg)
  }
  if (path.includes("code") || msg.toLowerCase().includes("code")) {
    throw new InvalidPartnerCodeError(msg)
  }
  if (path.includes("name") || msg.toLowerCase().includes("nom")) {
    throw new InvalidPartnerNameError(msg)
  }
  throw new InvalidPartnerCodeError(msg)
}

function parseOrThrow<T>(parse: () => T): T {
  try {
    return parse()
  } catch (e) {
    if (e instanceof ZodError) mapZodToBusiness(e)
    throw e
  }
}

function mapPersistence(error: unknown): never {
  if (
    error instanceof PartnerAlreadyExistsError ||
    error instanceof DomainAlreadyExistsError ||
    error instanceof PartnerNotFoundError ||
    error instanceof DomainNotFoundError ||
    error instanceof InvalidDomainError ||
    error instanceof InvalidPartnerCodeError ||
    error instanceof InvalidPartnerNameError ||
    error instanceof PartnerAdminPersistenceError
  ) {
    throw error
  }
  if (isUniqueConstraintError(error)) {
    // Ambigu hors contexte — le service mappe P2002 au site d’appel.
    throw new PartnerAdminPersistenceError()
  }
  throw new PartnerAdminPersistenceError()
}

export class AcquisitionPartnerAdminService {
  private readonly db: PartnerAdminDb

  constructor(deps: AcquisitionPartnerAdminServiceDeps = {}) {
    this.db = deps.db ?? (prisma as unknown as PartnerAdminDb)
  }

  async createPartner(input: CreatePartnerInput): Promise<PartnerAdminPartner> {
    const data = parseOrThrow(() => createPartnerSchema.parse(input))

    try {
      return await this.db.$transaction(async (tx) => {
        const existing = await tx.acquisitionPartner.findUnique({
          where: {
            companyId_code: { companyId: data.companyId, code: data.code },
          },
        })
        if (existing) throw new PartnerAlreadyExistsError()

        return tx.acquisitionPartner.create({
          data: {
            companyId: data.companyId,
            name: data.name,
            code: data.code,
            connector: data.connector ?? DEFAULT_CONNECTOR,
            pipeline: data.pipeline ?? DEFAULT_PIPELINE,
            active: data.active ?? true,
          },
        })
      })
    } catch (e) {
      if (e instanceof PartnerAlreadyExistsError) throw e
      if (isUniqueConstraintError(e)) throw new PartnerAlreadyExistsError()
      mapPersistence(e)
    }
  }

  async addDomain(input: AddDomainInput): Promise<PartnerAdminDomain> {
    const data = parseOrThrow(() => addDomainSchema.parse(input))

    try {
      return await this.db.$transaction(async (tx) => {
        const partner = await tx.acquisitionPartner.findFirst({
          where: { id: data.partnerId, companyId: data.companyId },
        })
        if (!partner) throw new PartnerNotFoundError()

        const existing = await tx.acquisitionPartnerDomain.findUnique({
          where: {
            companyId_domainNormalized: {
              companyId: data.companyId,
              domainNormalized: data.domain,
            },
          },
        })
        if (existing) throw new DomainAlreadyExistsError()

        return tx.acquisitionPartnerDomain.create({
          data: {
            companyId: data.companyId,
            partnerId: partner.id,
            domainNormalized: data.domain,
            active: data.active ?? true,
          },
        })
      })
    } catch (e) {
      if (e instanceof PartnerNotFoundError) throw e
      if (e instanceof DomainAlreadyExistsError) throw e
      if (isUniqueConstraintError(e)) throw new DomainAlreadyExistsError()
      mapPersistence(e)
    }
  }

  async activatePartner(input: PartnerRefInput): Promise<PartnerAdminPartner> {
    return this.setPartnerActive(input, true)
  }

  async deactivatePartner(input: PartnerRefInput): Promise<PartnerAdminPartner> {
    return this.setPartnerActive(input, false)
  }

  async activateDomain(input: DomainRefInput): Promise<PartnerAdminDomain> {
    return this.setDomainActive(input, true)
  }

  async deactivateDomain(input: DomainRefInput): Promise<PartnerAdminDomain> {
    return this.setDomainActive(input, false)
  }

  async renamePartner(input: RenamePartnerInput): Promise<PartnerAdminPartner> {
    const data = parseOrThrow(() => renamePartnerSchema.parse(input))

    try {
      return await this.db.$transaction(async (tx) => {
        const updated = await tx.acquisitionPartner.updateMany({
          where: { id: data.partnerId, companyId: data.companyId },
          data: { name: data.name },
        })
        if (updated.count === 0) throw new PartnerNotFoundError()

        const row = await tx.acquisitionPartner.findFirst({
          where: { id: data.partnerId, companyId: data.companyId },
        })
        if (!row) throw new PartnerNotFoundError()
        return row
      })
    } catch (e) {
      if (e instanceof PartnerNotFoundError) throw e
      mapPersistence(e)
    }
  }

  private async setPartnerActive(
    input: PartnerRefInput,
    active: boolean
  ): Promise<PartnerAdminPartner> {
    const data = parseOrThrow(() => partnerRefSchema.parse(input))

    try {
      return await this.db.$transaction(async (tx) => {
        const updated = await tx.acquisitionPartner.updateMany({
          where: { id: data.partnerId, companyId: data.companyId },
          data: { active },
        })
        if (updated.count === 0) throw new PartnerNotFoundError()

        const row = await tx.acquisitionPartner.findFirst({
          where: { id: data.partnerId, companyId: data.companyId },
        })
        if (!row) throw new PartnerNotFoundError()
        return row
      })
    } catch (e) {
      if (e instanceof PartnerNotFoundError) throw e
      mapPersistence(e)
    }
  }

  private async setDomainActive(
    input: DomainRefInput,
    active: boolean
  ): Promise<PartnerAdminDomain> {
    const data = parseOrThrow(() => domainRefSchema.parse(input))

    try {
      return await this.db.$transaction(async (tx) => {
        const updated = await tx.acquisitionPartnerDomain.updateMany({
          where: { id: data.domainId, companyId: data.companyId },
          data: { active },
        })
        if (updated.count === 0) throw new DomainNotFoundError()

        const row = await tx.acquisitionPartnerDomain.findFirst({
          where: { id: data.domainId, companyId: data.companyId },
        })
        if (!row) throw new DomainNotFoundError()
        return row
      })
    } catch (e) {
      if (e instanceof DomainNotFoundError) throw e
      mapPersistence(e)
    }
  }
}

/** Instance défaut (hors composition root runtime). */
export const acquisitionPartnerAdminService = new AcquisitionPartnerAdminService()
