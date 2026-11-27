export const PRINT_MANAGER_STUDIO_URL = "https://app.galyaevents.fr/studio"

const projectIds = {
  production: "prj_06FRa8dOdmHA8dD4QSIAqh0pTE8y",
  recette: "prj_CRp6XttdXjBjPMjJMSMbsUp6hwVD",
} as const

export type ImprimerieTarget = keyof typeof projectIds
type ImprimerieUser = { companyId?: string | null; role?: string | null }
type ImprimerieEnvironment = Readonly<Record<string, string | undefined>>

export function imprimerieTarget(env: ImprimerieEnvironment = process.env): ImprimerieTarget | undefined {
  if (env.VERCEL_ENV !== "production") return
  if (env.VERCEL_PROJECT_ID === projectIds.production) return "production"
  if (env.VERCEL_PROJECT_ID === projectIds.recette) return "recette"
}

function authorizedCompanyId(
  user: ImprimerieUser,
  configuredCompanyId: string | undefined,
) {
  const companyId = configuredCompanyId?.trim()
  if (!companyId || user.companyId !== companyId) return
  if (user.role !== "ADMIN" && user.role !== "SUPER_ADMIN") return
  return companyId
}

export function imprimerieProductionMenuVisible(
  user: ImprimerieUser,
  env: ImprimerieEnvironment = process.env,
) {
  if (imprimerieTarget(env) === "production" && authorizedCompanyId(user, env.IMPRIMERIE_MENU_COMPANY_ID)) {
    return true
  }
  return Boolean(imprimerieProductionDossier(user, env))
}

export function imprimerieProductionDossier(
  user: ImprimerieUser,
  env: ImprimerieEnvironment = process.env,
) {
  const target = imprimerieTarget(env)
  if (!target) return
  const enabled = target === "recette" ? env.IMPRIMERIE_RECETTE_ENABLED : env.IMPRIMERIE_PRODUCTION_ENABLED
  if (enabled !== "true") return

  const companyId = authorizedCompanyId(user, env.IMPRIMERIE_COMPANY_ID)
  const worksiteId = env.IMPRIMERIE_WORKSITE_ID?.trim()
  const quoteNumber = env.IMPRIMERIE_QUOTE_NUMBER?.trim()
  if (!companyId || !worksiteId || !quoteNumber || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(quoteNumber)) return

  const invoiceScope = JSON.stringify([companyId, worksiteId, quoteNumber])
  const invoiceRequestScope = target === "production" && env.IMPRIMERIE_INVOICE_READ_SCOPE === invoiceScope
    ? encodeURIComponent(invoiceScope)
    : undefined
  return { target, companyId, worksiteId, quoteNumber, ...(invoiceRequestScope ? { invoiceRequestScope } : {}) }
}

export function imprimerieWorksiteHref(
  user: ImprimerieUser,
  worksite: { id: string; companyId: string },
  env: ImprimerieEnvironment = process.env,
) {
  const dossier = imprimerieProductionDossier(user, env)
  if (!dossier || dossier.companyId !== worksite.companyId || dossier.worksiteId !== worksite.id) return

  return "/imprimerie"
}
