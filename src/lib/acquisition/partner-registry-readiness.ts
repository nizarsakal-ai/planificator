/**
 * PLAN-ACQ-V2 Lot I — Readiness durable multi-partenaires (lecture seule).
 * Prêt ⇔ ≥1 partenaire actif + ≥1 identité active (domaine OU email).
 * Pas d’exigence LAURALU.
 */

export const READINESS_ERROR = {
  TABLES_INACCESSIBLE: "TABLES_INACCESSIBLE",
  COMPANY_LOOKUP_FAILED: "COMPANY_LOOKUP_FAILED",
  DATABASE_ERROR: "DATABASE_ERROR",
  NO_COMPANIES_FOUND: "NO_COMPANIES_FOUND",
} as const

export type ReadinessErrorCode =
  (typeof READINESS_ERROR)[keyof typeof READINESS_ERROR]

export type PartnerRegistryReadinessReport = {
  companiesTotal: number
  companiesReady: number
  companiesNotReady: number
  /** Companies sans aucun partenaire actif */
  missingActivePartner: string[]
  /** Companies avec partenaire actif mais sans domaine/email actif */
  missingActiveIdentity: string[]
  databaseErrors: Array<{ companyId: string | null; code: ReadinessErrorCode }>
  /** @deprecated cutover — toujours [] en readiness durable */
  missingLauraluPartner: string[]
  inactiveLauraluPartner: string[]
  missingLauraluDomain: string[]
  inactiveLauraluDomain: string[]
  lauraluDomainLinkedToWrongPartner: string[]
}

export type PartnerRegistryReadinessDb = {
  company: {
    findMany: (args: {
      select: { id: true }
      orderBy: { id: "asc" }
    }) => Promise<Array<{ id: string }>>
  }
  acquisitionPartner: {
    findMany: (args: {
      where: { companyId: string; active: true }
      select: { id: true }
    }) => Promise<Array<{ id: string }>>
  }
  acquisitionPartnerDomain: {
    count: (args: {
      where: { companyId: string; active: true; partnerId: { in: string[] } }
    }) => Promise<number>
  }
  acquisitionPartnerEmail?: {
    count: (args: {
      where: { companyId: string; active: true; partnerId: { in: string[] } }
    }) => Promise<number>
  }
}

function emptyReport(): PartnerRegistryReadinessReport {
  return {
    companiesTotal: 0,
    companiesReady: 0,
    companiesNotReady: 0,
    missingActivePartner: [],
    missingActiveIdentity: [],
    databaseErrors: [],
    missingLauraluPartner: [],
    inactiveLauraluPartner: [],
    missingLauraluDomain: [],
    inactiveLauraluDomain: [],
    lauraluDomainLinkedToWrongPartner: [],
  }
}

function mapDbError(e: unknown): ReadinessErrorCode {
  if (typeof e === "object" && e !== null && "code" in e) {
    const code = String((e as { code?: string }).code ?? "")
    if (code === "P2021" || code === "P2010") return READINESS_ERROR.TABLES_INACCESSIBLE
  }
  return READINESS_ERROR.DATABASE_ERROR
}

/**
 * Readiness durable : au moins un partenaire actif + une identité (domaine|email) active.
 */
export async function checkAcquisitionPartnerRegistryReadiness(
  db: PartnerRegistryReadinessDb
): Promise<PartnerRegistryReadinessReport> {
  const report = emptyReport()

  let companies: Array<{ id: string }>
  try {
    companies = await db.company.findMany({
      select: { id: true },
      orderBy: { id: "asc" },
    })
  } catch (e) {
    report.databaseErrors.push({ companyId: null, code: mapDbError(e) })
    return report
  }

  report.companiesTotal = companies.length
  if (companies.length === 0) {
    report.databaseErrors.push({
      companyId: null,
      code: READINESS_ERROR.NO_COMPANIES_FOUND,
    })
    return report
  }

  for (const { id: companyId } of companies) {
    let ready = true
    try {
      const partners = await db.acquisitionPartner.findMany({
        where: { companyId, active: true },
        select: { id: true },
      })
      if (partners.length === 0) {
        report.missingActivePartner.push(companyId)
        ready = false
      } else {
        const partnerIds = partners.map((p) => p.id)
        const domainCount = await db.acquisitionPartnerDomain.count({
          where: { companyId, active: true, partnerId: { in: partnerIds } },
        })
        const emailCount = db.acquisitionPartnerEmail
          ? await db.acquisitionPartnerEmail.count({
              where: { companyId, active: true, partnerId: { in: partnerIds } },
            })
          : 0
        if (domainCount + emailCount === 0) {
          report.missingActiveIdentity.push(companyId)
          ready = false
        }
      }
    } catch {
      report.databaseErrors.push({
        companyId,
        code: READINESS_ERROR.COMPANY_LOOKUP_FAILED,
      })
      ready = false
    }

    if (ready) report.companiesReady += 1
    else report.companiesNotReady += 1
  }

  return report
}

export function readinessExitCode(report: PartnerRegistryReadinessReport): 0 | 1 {
  if (report.databaseErrors.length > 0) return 1
  if (report.companiesTotal === 0) return 1
  if (report.companiesNotReady > 0) return 1
  if (report.companiesReady !== report.companiesTotal) return 1
  return 0
}
