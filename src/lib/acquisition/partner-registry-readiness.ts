/**
 * PLAN-ACQ-012-LOT-1.4-R4 — Preflight lecture seule du registre partenaires.
 *
 * Readiness de **transition** (cutover depuis l’ancien gate `lauralu.fr`) :
 * pour chaque Company, exiger exactement partenaire `code=lauralu` actif +
 * domaine `lauralu.fr` actif lié à ce partenaire.
 *
 * Cette règle est temporaire au cutover — pas une obligation permanente
 * de la plateforme (voir docs/acquisition-partner-registry-cutover.md).
 *
 * Aucune écriture. Aucune réactivation. Aucun fallback historique.
 *
 * Convention zéro Company : `companiesTotal === 0` → échec (`NO_COMPANIES_FOUND`),
 * exit 1 (évite un faux vert sur mauvaise cible).
 */

import {
  LAURALU_DOMAIN_NORMALIZED,
  LAURALU_PARTNER_CODE,
} from "@/lib/acquisition/partner-registry-bootstrap"

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
  missingLauraluPartner: string[]
  inactiveLauraluPartner: string[]
  missingLauraluDomain: string[]
  inactiveLauraluDomain: string[]
  lauraluDomainLinkedToWrongPartner: string[]
  databaseErrors: Array<{ companyId: string | null; code: ReadinessErrorCode }>
}

export type PartnerRegistryReadinessDb = {
  company: {
    findMany: (args: {
      select: { id: true }
      orderBy: { id: "asc" }
    }) => Promise<Array<{ id: string }>>
  }
  acquisitionPartner: {
    findUnique: (args: {
      where: { companyId_code: { companyId: string; code: string } }
      select: { id: true; companyId: true; code: true; active: true }
    }) => Promise<{
      id: string
      companyId: string
      code: string
      active: boolean
    } | null>
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
        active: true
      }
    }) => Promise<{
      id: string
      companyId: string
      partnerId: string
      domainNormalized: string
      active: boolean
    } | null>
  }
}

function emptyReport(): PartnerRegistryReadinessReport {
  return {
    companiesTotal: 0,
    companiesReady: 0,
    companiesNotReady: 0,
    missingLauraluPartner: [],
    inactiveLauraluPartner: [],
    missingLauraluDomain: [],
    inactiveLauraluDomain: [],
    lauraluDomainLinkedToWrongPartner: [],
    databaseErrors: [],
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
 * Vérifie la readiness de transition cutover pour toutes les Companies.
 * Lecture seule — ne crée / ne met à jour / ne supprime / ne réactive rien.
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
    report.databaseErrors.push({
      companyId: null,
      code: mapDbError(e),
    })
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
      const partner = await db.acquisitionPartner.findUnique({
        where: {
          companyId_code: { companyId, code: LAURALU_PARTNER_CODE },
        },
        select: { id: true, companyId: true, code: true, active: true },
      })

      if (!partner) {
        report.missingLauraluPartner.push(companyId)
        ready = false
      } else if (partner.companyId !== companyId || partner.code !== LAURALU_PARTNER_CODE) {
        // Incohérence tenant / code — traité comme partenaire absent pour la transition.
        report.missingLauraluPartner.push(companyId)
        ready = false
      } else if (!partner.active) {
        report.inactiveLauraluPartner.push(companyId)
        ready = false
      }

      const domain = await db.acquisitionPartnerDomain.findUnique({
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
          active: true,
        },
      })

      if (!domain) {
        report.missingLauraluDomain.push(companyId)
        ready = false
      } else if (
        domain.companyId !== companyId ||
        domain.domainNormalized !== LAURALU_DOMAIN_NORMALIZED
      ) {
        report.missingLauraluDomain.push(companyId)
        ready = false
      } else {
        if (!domain.active) {
          report.inactiveLauraluDomain.push(companyId)
          ready = false
        }
        // Lien partenaire : uniquement si le partenaire lauralu a été résolu.
        if (partner && partner.companyId === companyId && partner.code === LAURALU_PARTNER_CODE) {
          if (domain.partnerId !== partner.id) {
            report.lauraluDomainLinkedToWrongPartner.push(companyId)
            ready = false
          }
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

/**
 * Exit 0 uniquement si au moins une Company existe, toutes sont prêtes,
 * et aucune erreur DB / NO_COMPANIES_FOUND.
 */
export function readinessExitCode(report: PartnerRegistryReadinessReport): 0 | 1 {
  if (report.databaseErrors.length > 0) return 1
  if (report.companiesTotal === 0) return 1
  if (report.companiesNotReady > 0) return 1
  if (report.companiesReady !== report.companiesTotal) return 1
  return 0
}
