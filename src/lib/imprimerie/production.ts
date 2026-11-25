export const PRINT_MANAGER_STUDIO_URL = "https://app.galyaevents.fr/studio"

type ImprimerieUser = { companyId?: string | null; role?: string | null }
type ImprimerieEnvironment = Readonly<Record<string, string | undefined>>

function productionCompanyId(
  user: ImprimerieUser,
  configuredCompanyId: string | undefined,
  env: ImprimerieEnvironment,
) {
  const companyId = configuredCompanyId?.trim()
  if (env.VERCEL_ENV !== "production" || !companyId || user.companyId !== companyId) return
  if (user.role !== "ADMIN" && user.role !== "SUPER_ADMIN") return
  return companyId
}

export function imprimerieProductionMenuVisible(
  user: ImprimerieUser,
  env: ImprimerieEnvironment = process.env,
) {
  return Boolean(
    productionCompanyId(user, env.IMPRIMERIE_MENU_COMPANY_ID, env) ??
    imprimerieProductionDossier(user, env),
  )
}

export function imprimerieProductionDossier(
  user: ImprimerieUser,
  env: ImprimerieEnvironment = process.env,
) {
  if (env.IMPRIMERIE_PRODUCTION_ENABLED !== "true") return

  const companyId = productionCompanyId(user, env.IMPRIMERIE_COMPANY_ID, env)
  const worksiteId = env.IMPRIMERIE_WORKSITE_ID?.trim()
  const quoteNumber = env.IMPRIMERIE_QUOTE_NUMBER?.trim()
  if (!companyId || !worksiteId || !quoteNumber || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(quoteNumber)) return

  return { companyId, worksiteId, quoteNumber }
}
