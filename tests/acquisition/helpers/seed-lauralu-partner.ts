/**
 * Helper tests — seed minimal LAURALU (parité bootstrap LOT-1.2) pour une Company.
 * Ne modifie pas le script bootstrap opérationnel.
 */
import type { PrismaClient } from "@prisma/client"
import {
  LAURALU_DOMAIN_NORMALIZED,
  LAURALU_PARTNER_CODE,
  LAURALU_PARTNER_NAME,
  LAURALU_PARTNER_PIPELINE,
} from "@/lib/acquisition/partner-registry-bootstrap"

export async function seedLauraluPartnerForCompany(
  db: PrismaClient,
  companyId: string
): Promise<void> {
  const partner = await db.acquisitionPartner.upsert({
    where: {
      companyId_code: { companyId, code: LAURALU_PARTNER_CODE },
    },
    create: {
      companyId,
      name: LAURALU_PARTNER_NAME,
      code: LAURALU_PARTNER_CODE,
      connector: "GMAIL",
      pipeline: LAURALU_PARTNER_PIPELINE,
      active: true,
    },
    update: {},
  })

  await db.acquisitionPartnerDomain.upsert({
    where: {
      companyId_domainNormalized: {
        companyId,
        domainNormalized: LAURALU_DOMAIN_NORMALIZED,
      },
    },
    create: {
      companyId,
      partnerId: partner.id,
      domainNormalized: LAURALU_DOMAIN_NORMALIZED,
      active: true,
    },
    update: {},
  })
}
