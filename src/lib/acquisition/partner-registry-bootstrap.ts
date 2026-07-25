/**
 * PLAN-ACQ-012-LOT-1.2 — Bootstrap idempotent du registre partenaires.
 *
 * Hors chemin chaud : ne remplace PAS ELIGIBLE_SENDER_DOMAIN / isEligibleSenderDomain.
 *
 * Sémantique PostgreSQL (obligatoire) :
 * - Une unité atomique par Company s’exécute dans une `$transaction` interactive.
 * - P2002 n’est JAMAIS catché pour continuer la même TX (TX aborted côté PG).
 * - P2002 remonte → Prisma rollback → orchestrateur relit sur le client RACINE.
 * - Au plus UN retry de la TX Company si l’état est incomplet sans conflit.
 */

export const LAURALU_PARTNER_CODE = "lauralu" as const
export const LAURALU_PARTNER_NAME = "LAURALU" as const
export const LAURALU_PARTNER_PIPELINE = "consultations" as const
export const LAURALU_DOMAIN_NORMALIZED = "lauralu.fr" as const

/** Codes d’échec sûrs (jamais message/stack Prisma brut). */
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
}

export type PartnerRegistryBootstrapFailure = {
  companyId: string
  reason: BootstrapErrorCode
}

export type PartnerRegistryBootstrapResult = {
  companiesTotal: number
  companiesSucceeded: number
  companiesFailed: number
  partnersCreated: number
  domainsCreated: number
  alreadyPresent: number
  concurrentlyCreated: number
  conflicts: PartnerRegistryBootstrapConflict[]
  failed: PartnerRegistryBootstrapFailure[]
}

type PartnerRow = {
  id: string
  companyId: string
  code: string
}

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
    alreadyPresent: 0,
    concurrentlyCreated: 0,
    conflicts: [],
    failed: [],
  }
}

type CompanyOutcome =
  | {
      kind: "already_present"
    }
  | {
      kind: "created"
      partnersCreated: 0 | 1
      domainsCreated: 0 | 1
    }
  | {
      kind: "concurrent"
    }
  | {
      kind: "conflict"
    }
  | {
      kind: "failed"
      reason: BootstrapErrorCode
    }

type TxSuccess =
  | { status: "already_present" }
  | {
      status: "created"
      partnersCreated: 0 | 1
      domainsCreated: 0 | 1
    }

/** Erreur métier contrôlée (hors P2002) — provoque rollback si levée dans la TX. */
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

async function findLauraluPartner(
  client: PartnerRegistryBootstrapTx,
  companyId: string
): Promise<PartnerRow | null> {
  return client.acquisitionPartner.findUnique({
    where: {
      companyId_code: { companyId, code: LAURALU_PARTNER_CODE },
    },
    select: { id: true, companyId: true, code: true },
  })
}

async function findLauraluDomain(
  client: PartnerRegistryBootstrapTx,
  companyId: string
): Promise<DomainRow | null> {
  return client.acquisitionPartnerDomain.findUnique({
    where: {
      companyId_domainNormalized: {
        companyId,
        domainNormalized: LAURALU_DOMAIN_NORMALIZED,
      },
    },
    select: {
      id: true,
      companyId: true,
      partnerId: true,
      domainNormalized: true,
    },
  })
}

/**
 * Relecture RACINE après P2002 (jamais sur `tx`).
 * - complete : partenaire + domaine liés
 * - conflict : domaine sur un autre partenaire
 * - incomplete : partenaire et/ou domaine manquants, sans conflit
 */
async function inspectRootState(
  db: PartnerRegistryBootstrapTx,
  companyId: string
): Promise<"complete" | "conflict" | "incomplete"> {
  const domain = await findLauraluDomain(db, companyId)
  const partner = await findLauraluPartner(db, companyId)

  if (domain) {
    if (partner && domain.partnerId === partner.id) return "complete"
    return "conflict"
  }
  return "incomplete"
}

/**
 * Unité atomique Company.
 * Ne catch PAS P2002 — laisse remonter pour rollback Prisma/PG.
 */
export async function runCompanyBootstrapTx(
  tx: PartnerRegistryBootstrapTx,
  companyId: string
): Promise<TxSuccess> {
  const existingDomain = await findLauraluDomain(tx, companyId)

  if (existingDomain) {
    const lauralu = await findLauraluPartner(tx, companyId)
    if (lauralu && existingDomain.partnerId === lauralu.id) {
      return { status: "already_present" }
    }
    // Conflit avant toute écriture — throw pour sortir proprement (pas de write).
    throw new DomainConflictError()
  }

  let partnersCreated: 0 | 1 = 0
  let partner = await findLauraluPartner(tx, companyId)
  if (!partner) {
    // P2002 éventuel remonte → TX aborted → orchestrateur hors TX.
    partner = await tx.acquisitionPartner.create({
      data: {
        companyId,
        name: LAURALU_PARTNER_NAME,
        code: LAURALU_PARTNER_CODE,
        connector: "GMAIL",
        pipeline: LAURALU_PARTNER_PIPELINE,
        active: true,
      },
      select: { id: true, companyId: true, code: true },
    })
    partnersCreated = 1
  }

  // P2002 éventuel remonte → rollback y compris partenaire créé ci-dessus.
  await tx.acquisitionPartnerDomain.create({
    data: {
      companyId,
      partnerId: partner.id,
      domainNormalized: LAURALU_DOMAIN_NORMALIZED,
      active: true,
    },
    select: {
      id: true,
      companyId: true,
      partnerId: true,
      domainNormalized: true,
    },
  })

  return {
    status: "created",
    partnersCreated,
    domainsCreated: 1,
  }
}

async function attemptCompanyTx(
  db: PartnerRegistryBootstrapDb,
  companyId: string
): Promise<TxSuccess> {
  return db.$transaction((tx) => runCompanyBootstrapTx(tx, companyId))
}

/**
 * Orchestrateur hors transaction pour UNE Company.
 * P2002 → relecture racine → concurrent | conflict | retry unique | failed.
 */
export async function bootstrapCompany(
  db: PartnerRegistryBootstrapDb,
  companyId: string
): Promise<CompanyOutcome> {
  const tryOnce = async (): Promise<
    | { ok: true; value: TxSuccess }
    | { ok: false; p2002: true }
    | { ok: false; p2002: false; reason: BootstrapErrorCode }
  > => {
    try {
      const value = await attemptCompanyTx(db, companyId)
      return { ok: true, value }
    } catch (error) {
      if (isUniqueConstraintError(error)) return { ok: false, p2002: true }
      const reason = classifyNonP2002Error(error)
      if (reason === BOOTSTRAP_ERROR.DOMAIN_CONFLICT) {
        return { ok: false, p2002: false, reason }
      }
      return { ok: false, p2002: false, reason }
    }
  }

  const first = await tryOnce()
  if (first.ok) {
    if (first.value.status === "already_present") return { kind: "already_present" }
    return {
      kind: "created",
      partnersCreated: first.value.partnersCreated,
      domainsCreated: first.value.domainsCreated,
    }
  }

  if (!first.p2002) {
    if (first.reason === BOOTSTRAP_ERROR.DOMAIN_CONFLICT) return { kind: "conflict" }
    return { kind: "failed", reason: first.reason }
  }

  // --- P2002 : relecture RACINE (pas tx) ---
  const afterFirst = await inspectRootState(db, companyId)
  if (afterFirst === "complete") return { kind: "concurrent" }
  if (afterFirst === "conflict") return { kind: "conflict" }

  // État incomplet sans conflit → UN seul retry de la TX Company.
  const second = await tryOnce()
  if (second.ok) {
    if (second.value.status === "already_present") return { kind: "concurrent" }
    return {
      kind: "created",
      partnersCreated: second.value.partnersCreated,
      domainsCreated: second.value.domainsCreated,
    }
  }

  if (!second.p2002) {
    if (second.reason === BOOTSTRAP_ERROR.DOMAIN_CONFLICT) return { kind: "conflict" }
    return { kind: "failed", reason: second.reason }
  }

  // Dernière relecture racine après 2ᵉ P2002.
  const afterSecond = await inspectRootState(db, companyId)
  if (afterSecond === "complete") return { kind: "concurrent" }
  if (afterSecond === "conflict") return { kind: "conflict" }
  return { kind: "failed", reason: BOOTSTRAP_ERROR.P2002_RETRY_EXHAUSTED }
}

/**
 * Bootstrap LAURALU pour toutes les Companies existantes.
 * Isolation : une Company en erreur n’arrête pas les suivantes.
 */
export async function bootstrapLauraluPartnerRegistry(
  db: PartnerRegistryBootstrapDb
): Promise<PartnerRegistryBootstrapResult> {
  const result = emptyResult()

  const companies = await db.company.findMany({
    select: { id: true },
    orderBy: { id: "asc" },
  })
  result.companiesTotal = companies.length

  for (const { id: companyId } of companies) {
    let outcome: CompanyOutcome
    try {
      outcome = await bootstrapCompany(db, companyId)
    } catch {
      outcome = { kind: "failed", reason: BOOTSTRAP_ERROR.UNKNOWN_ERROR }
    }

    switch (outcome.kind) {
      case "already_present":
        result.alreadyPresent += 1
        result.companiesSucceeded += 1
        break
      case "concurrent":
        result.concurrentlyCreated += 1
        result.companiesSucceeded += 1
        break
      case "created":
        result.partnersCreated += outcome.partnersCreated
        result.domainsCreated += outcome.domainsCreated
        result.companiesSucceeded += 1
        break
      case "conflict":
        result.conflicts.push({
          companyId,
          reason: BOOTSTRAP_ERROR.DOMAIN_CONFLICT,
        })
        break
      case "failed":
        result.companiesFailed += 1
        result.failed.push({ companyId, reason: outcome.reason })
        break
    }
  }

  return result
}

export function bootstrapExitCode(
  result: PartnerRegistryBootstrapResult
): 0 | 1 | 2 {
  if (result.companiesFailed > 0 || result.failed.length > 0) return 1
  if (result.conflicts.length > 0) return 2
  return 0
}
