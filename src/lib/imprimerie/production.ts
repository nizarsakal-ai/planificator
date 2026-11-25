export const PRINT_MANAGER_STUDIO_URL = "https://app.galyaevents.fr/studio"

type ImprimerieUser = { companyId?: string | null; role?: string | null }

export function imprimerieProductionDossier(
  user: ImprimerieUser,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  if (env.IMPRIMERIE_PRODUCTION_ENABLED !== "true" || env.VERCEL_ENV !== "production") return

  const companyId = env.IMPRIMERIE_COMPANY_ID?.trim()
  const worksiteId = env.IMPRIMERIE_WORKSITE_ID?.trim()
  const quoteNumber = env.IMPRIMERIE_QUOTE_NUMBER?.trim()
  if (!companyId || !worksiteId || !quoteNumber || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(quoteNumber)) return
  if (user.companyId !== companyId || (user.role !== "ADMIN" && user.role !== "SUPER_ADMIN")) return

  return { companyId, worksiteId, quoteNumber }
}
