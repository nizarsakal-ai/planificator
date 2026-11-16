import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import type { PartnerSourceView } from "@/lib/acquisition/admin/partner-sources"

/** Partenaires + domaines du tenant, pour l'écran Paramètres. */
export async function listConsultationSources(
  companyId: string,
  db: Pick<PrismaClient, "acquisitionPartner"> = prisma
): Promise<PartnerSourceView[]> {
  const partners = await db.acquisitionPartner.findMany({
    where: { companyId },
    select: {
      id: true,
      name: true,
      active: true,
      domains: { select: { id: true, domainNormalized: true, active: true }, orderBy: { domainNormalized: "asc" } },
    },
    orderBy: [{ active: "desc" }, { name: "asc" }],
  })
  return partners.map((p) => ({
    id: p.id,
    name: p.name,
    active: p.active,
    domains: p.domains.map((d) => ({ id: d.id, domain: d.domainNormalized, active: d.active })),
  }))
}
