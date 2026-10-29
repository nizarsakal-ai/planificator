import { prisma } from "@/lib/prisma"
import { logoForPdf } from "@/lib/company-logo"

/** Identité de la société active, résolue côté serveur depuis la session du layout. */
export async function CompanyBrand({ companyId }: { companyId: string }) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { name: true, logoUrl: true },
  })
  if (!company) return null
  const logo = logoForPdf(company.logoUrl)
  if (!logo) return null
  return (
    <div className="mb-6 flex flex-wrap items-center gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3" aria-label="Société active">
      {/* Fichier PNG validé et enregistré par le serveur, sans chargement externe. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={logo} alt={`Logo ${company.name}`} className="h-16 w-40 object-contain object-left" />
      <p className="text-base font-semibold text-slate-900">{company.name}</p>
    </div>
  )
}
