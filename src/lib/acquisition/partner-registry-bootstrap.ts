/**
 * PLAN-ACQ-012-LOT-1.2 / V2 Lot I — Bootstrap idempotent du registre partenaires.
 *
 * Data-driven via PartnerRegistrySeedSpec — aucun partenaire n’est une dépendance
 * pipeline. Le seed ops par défaut peut inclure LAURALU comme **donnée**.
 */

import {
  DEFAULT_CONSULTATION_PARTNER_SEEDS,
  LAURALU_DOMAIN_NORMALIZED,
  LAURALU_PARTNER_CODE,
  LAURALU_PARTNER_NAME,
  LAURALU_PARTNER_PIPELINE,
  type PartnerRegistrySeedSpec,
} from "@/lib/acquisition/partner-registry-seed"

export {
  DEFAULT_CONSULTATION_PARTNER_SEEDS,
  LAURALU_DOMAIN_NORMALIZED,
  LAURALU_PARTNER_CODE,
  LAURALU_PARTNER_NAME,
  LAURALU_PARTNER_PIPELINE,
  type PartnerRegistrySeedSpec,
}

export const BOOTSTRAP_ERROR = {
  DOMAIN_CONFLICT: "DOMAIN_CONFLICT",
  P2002_RETRY_EXHAUSTED: "P2002_RETRY_EXHAUSTED",
  DATABASE_ERROR: "DATABASE_ERROR",
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
} as const

export type BootstrapErrorCode =
  (typeof BOOTSTRAP_ERROR)[keyof typeof BOOTSTRAP_ERROR]

export type PartnerRegistryBootstrapConflict = {
  companyId: string
  reason: typeof BOOTSTRAP_ERROR.DOMAIN_CONFLICT
  seedCode?: string
}

export type PartnerRegistryBootstrapFailure = {
  companyId: string
  reason: BootstrapErrorCode
  seedCode?: string
}

export type PartnerRegistryBootstrapResult = {
  companiesTotal: number
  companiesSucceeded: number
  companiesFailed: number
  partnersCreated: number
  domainsCreated: number
  emailsCreated: number
  alreadyPresent: number
  concurrentlyCreated: number
  conflicts: PartnerRegistryBootstrapConflict[]
  failed: PartnerRegistryBootstrapFailure[]
}

type PartnerRow = { id: string; companyId: string; code: string }
type DomainRow = {
  id: string
  companyId: string
  partnerId: string
  domainNormalized: string
}

export type PartnerRegistryBootstrapTx = {
  company: {
    findMany: (args: {
      select: { id: true }
      orderBy: { id: "asc" }
    }) => Promise<Array<{ id: string }>>
  }
  acquisitionPartner: {
    findUnique: (args: {
      where: { companyId_code: { companyId: string; code: string } }
      select: { id: true; companyId: true; code: true }
    }) => Promise<PartnerRow | null>
    create: (args: {
      data: {
        companyId: string
        name: string
        code: string
        connector: "GMAIL"
        pipeline: string
        active: boolean
        priority?: number
        requireExactEmail?: boolean
        autoApproveEnabled?: boolean
        autoConvertEnabled?: boolean
        allowCreateClient?: boolean
        minConfidence?: number | null
      }
      select: { id: true; companyId: true; code: true }
    }) => Promise<PartnerRow>
  }
  acquisitionPartnerDomain: {
    findUnique: (args: {
      where: {
        companyId_domainNormalized: {
          companyId: string
          domainNormalized: string
        }
      }
      select: {
        id: true
        companyId: true
        partnerId: true
        domainNormalized: true
      }
    }) => Promise<DomainRow | null>
    create: (args: {
      data: {
        companyId: string
        partnerId: string
        domainNormalized: string
        active: boolean
      }
      select: {
        id: true
        companyId: true
        partnerId: true
        domainNormalized: true
      }
    }) => Promise<DomainRow>
  }
  acquisitionPartnerEmail?: {
    findUnique: (args: {
      where: {
        companyId_emailNormalized: { companyId: string; emailNormalized: string }
      }
      select: { id: true }
    }) => Promise<{ id: string } | null>
    create: (args: {
      data: {
        companyId: string
        partnerId: string
        emailNormalized: string
        active: boolean
      }
      select: { id: true }
    }) => Promise<{ id: string }>
  }
}

export type PartnerRegistryBootstrapDb = PartnerRegistryBootstrapTx & {
  $transaction: <T>(
    fn: (tx: PartnerRegistryBootstrapTx) => Promise<T>
  ) => Promise<T>
}

export function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  )
}

function emptyResult(): PartnerRegistryBootstrapResult {
  return {
    companiesTotal: 0,
    companiesSucceeded: 0,
    companiesFailed: 0,
    partnersCreated: 0,
    domainsCreated: 0,
    emailsCreated: 0,
    alreadyPresent: 0,
    concurrentlyCreated: 0,
    conflicts: [],
    failed: [],
  }
}

class DomainConflictError extends Error {
  readonly code = BOOTSTRAP_ERROR.DOMAIN_CONFLICT
  constructor() {
    super(BOOTSTRAP_ERROR.DOMAIN_CONFLICT)
    this.name = "DomainConflictError"
  }
}

function classifyNonP2002Error(error: unknown): BootstrapErrorCode {
  if (error instanceof DomainConflictError) return BOOTSTRAP_ERROR.DOMAIN_CONFLICT
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    String((error as { code: string }).code).startsWith("P")
  ) {
    return BOOTSTRAP_ERROR.DATABASE_ERROR
  }
  return BOOTSTRAP_ERROR.UNKNOWN_ERROR
}

type TxSuccess =
  | { status: "already_present" }
  | {
      status: "created"
      partnersCreated: 0 | 1
      domainsCreated: number
      emailsCreated: number
    }

export async function runCompanySeedTx(
  tx: PartnerRegistryBootstrapTx,
  companyId: string,
  seed: PartnerRegistrySeedSpec
): Promise<TxSuccess> {
  const code = seed.code.trim().toLowerCase()
  const domains = seed.domains.map((d) => d.trim().toLowerCase()).filter(Boolean)
  if (domains.length === 0) {
    throw new Error("SEED_WITHOUT_DOMAIN")
  }

  let partnersCreated: 0 | 1 = 0
  let domainsCreated = 0
  let emailsCreated = 0

  let partner = await tx.acquisitionPartner.findUnique({
    where: { companyId_code: { companyId, code } },
    select: { id: true, companyId: true, code: true },
  })

  if (!partner) {
    partner = await tx.acquisitionPartner.create({
      data: {
        companyId,
        name: seed.name.trim(),
        code,
        connector: "GMAIL",
        pipeline: seed.pipeline ?? "consultations",
        active: true,
        priority: seed.priority ?? 100,
        requireExactEmail: seed.requireExactEmail ?? false,
        autoApproveEnabled: seed.autoApproveEnabled ?? false,
        autoConvertEnabled: seed.autoConvertEnabled ?? false,
        allowCreateClient: seed.allowCreateClient ?? false,
        minConfidence: seed.minConfidence ?? null,
      },
      select: { id: true, companyId: true, code: true },
    })
    partnersCreated = 1
  }

  let allDomainsPresent = true
  for (const domainNormalized of domains) {
    const existing = await tx.acquisitionPartnerDomain.findUnique({
      where: {
        companyId_domainNormalized: { companyId, domainNormalized },
      },
      select: {
        id: true,
        companyId: true,
        partnerId: true,
        domainNormalized: true,
      },
    })
    if (existing) {
      if (existing.partnerId !== partner.id) throw new DomainConflictError()
      continue
    }
    allDomainsPresent = false
    await tx.acquisitionPartnerDomain.create({
      data: {
        companyId,
        partnerId: partner.id,
        domainNormalized,
        active: true,
      },
      select: {
        id: true,
        companyId: true,
        partnerId: true,
        domainNormalized: true,
      },
    })
    domainsCreated += 1
  }

  for (const rawEmail of seed.emails ?? []) {
    const emailNormalized = rawEmail.trim().toLowerCase()
    if (!emailNormalized || !tx.acquisitionPartnerEmail) continue
    const existing = await tx.acquisitionPartnerEmail.findUnique({
      where: {
        companyId_emailNormalized: { companyId, emailNormalized },
      },
      select: { id: true },
    })
    if (existing) continue
    await tx.acquisitionPartnerEmail.create({
      data: {
        companyId,
        partnerId: partner.id,
        emailNormalized,
        active: true,
      },
      select: { id: true },
    })
    emailsCreated += 1
  }

  if (
    partnersCreated === 0 &&
    domainsCreated === 0 &&
    emailsCreated === 0 &&
    allDomainsPresent
  ) {
    return { status: "already_present" }
  }
  return { status: "created", partnersCreated, domainsCreated, emailsCreated }
}

async function bootstrapCompanySeed(
  db: PartnerRegistryBootstrapDb,
  companyId: string,
  seed: PartnerRegistrySeedSpec
): Promise<
  | { kind: "already_present" }
  | {
      kind: "created"
      partnersCreated: 0 | 1
      domainsCreated: number
      emailsCreated: number
    }
  | { kind: "concurrent" }
  | { kind: "conflict" }
  | { kind: "failed"; reason: BootstrapErrorCode }
> {
  const tryOnce = async () => {
    try {
      const value = await db.$transaction((tx) =>
        runCompanySeedTx(tx, companyId, seed)
      )
      return { ok: true as const, value }
    } catch (error) {
      if (isUniqueConstraintError(error)) return { ok: false as const, p2002: true as const }
      const reason = classifyNonP2002Error(error)
      return { ok: false as const, p2002: false as const, reason }
    }
  }

  const first = await tryOnce()
  if (first.ok) {
    if (first.value.status === "already_present") return { kind: "already_present" }
    return {
      kind: "created",
      partnersCreated: first.value.partnersCreated,
      domainsCreated: first.value.domainsCreated,
      emailsCreated: first.value.emailsCreated,
    }
  }
  if (!first.p2002) {
    if (first.reason === BOOTSTRAP_ERROR.DOMAIN_CONFLICT) return { kind: "conflict" }
    return { kind: "failed", reason: first.reason }
  }

  const second = await tryOnce()
  if (second.ok) {
    if (second.value.status === "already_present") return { kind: "concurrent" }
    return {
      kind: "created",
      partnersCreated: second.value.partnersCreated,
      domainsCreated: second.value.domainsCreated,
      emailsCreated: second.value.emailsCreated,
    }
  }
  if (!second.p2002 && second.reason === BOOTSTRAP_ERROR.DOMAIN_CONFLICT) {
    return { kind: "conflict" }
  }
  return { kind: "failed", reason: BOOTSTRAP_ERROR.P2002_RETRY_EXHAUSTED }
}

export async function bootstrapPartnerRegistryFromSeeds(
  db: PartnerRegistryBootstrapDb,
  seeds: PartnerRegistrySeedSpec[] = DEFAULT_CONSULTATION_PARTNER_SEEDS
): Promise<PartnerRegistryBootstrapResult> {
  const result = emptyResult()
  const companies = await db.company.findMany({
    select: { id: true },
    orderBy: { id: "asc" },
  })
  result.companiesTotal = companies.length

  for (const { id: companyId } of companies) {
    let companyOk = true
    let companyAlready = true
    for (const seed of seeds) {
      let outcome: Awaited<ReturnType<typeof bootstrapCompanySeed>>
      try {
        outcome = await bootstrapCompanySeed(db, companyId, seed)
      } catch {
        outcome = { kind: "failed", reason: BOOTSTRAP_ERROR.UNKNOWN_ERROR }
      }
      switch (outcome.kind) {
        case "already_present":
          break
        case "concurrent":
          result.concurrentlyCreated += 1
          companyAlready = false
          break
        case "created":
          result.partnersCreated += outcome.partnersCreated
          result.domainsCreated += outcome.domainsCreated
          result.emailsCreated += outcome.emailsCreated
          companyAlready = false
          break
        case "conflict":
          result.conflicts.push({
            companyId,
            reason: BOOTSTRAP_ERROR.DOMAIN_CONFLICT,
            seedCode: seed.code,
          })
          companyOk = false
          break
        case "failed":
          result.companiesFailed += 1
          result.failed.push({
            companyId,
            reason: outcome.reason,
            seedCode: seed.code,
          })
          companyOk = false
          break
      }
    }
    if (companyOk) {
      result.companiesSucceeded += 1
      if (companyAlready) result.alreadyPresent += 1
    }
  }

  return result
}

/** Compat : seed ops par défaut (données, pas dépendance pipeline). */
export async function bootstrapLauraluPartnerRegistry(
  db: PartnerRegistryBootstrapDb
): Promise<PartnerRegistryBootstrapResult> {
  return bootstrapPartnerRegistryFromSeeds(db, DEFAULT_CONSULTATION_PARTNER_SEEDS)
}

/** Compat tests cutover. */
export async function runCompanyBootstrapTx(
  tx: PartnerRegistryBootstrapTx,
  companyId: string
): Promise<TxSuccess> {
  return runCompanySeedTx(tx, companyId, DEFAULT_CONSULTATION_PARTNER_SEEDS[0]!)
}

export async function bootstrapCompany(
  db: PartnerRegistryBootstrapDb,
  companyId: string
): Promise<
  | { kind: "already_present" }
  | {
      kind: "created"
      partnersCreated: 0 | 1
      domainsCreated: number
      emailsCreated?: number
    }
  | { kind: "concurrent" }
  | { kind: "conflict" }
  | { kind: "failed"; reason: BootstrapErrorCode }
> {
  return bootstrapCompanySeed(db, companyId, DEFAULT_CONSULTATION_PARTNER_SEEDS[0]!)
}

export function bootstrapExitCode(
  result: PartnerRegistryBootstrapResult
): 0 | 1 | 2 {
  if (result.companiesFailed > 0 || result.failed.length > 0) return 1
  if (result.conflicts.length > 0) return 2
  return 0
}
