/**
 * PLAN-ACQ-012-LOT-1.5 — Types administration registre partenaires.
 */

import type { AcquisitionSource } from "@prisma/client"

export type PartnerAdminPartner = {
  id: string
  companyId: string
  name: string
  code: string
  connector: AcquisitionSource
  pipeline: string
  active: boolean
  createdAt: Date
  updatedAt: Date
}

export type PartnerAdminDomain = {
  id: string
  companyId: string
  partnerId: string
  domainNormalized: string
  active: boolean
  createdAt: Date
  updatedAt: Date
}

export type CreatePartnerInput = {
  companyId: string
  name: string
  code: string
  connector?: AcquisitionSource
  pipeline?: string
  active?: boolean
}

export type AddDomainInput = {
  companyId: string
  partnerId: string
  domain: string
  active?: boolean
}

export type PartnerRefInput = {
  companyId: string
  partnerId: string
}

export type DomainRefInput = {
  companyId: string
  domainId: string
}

export type RenamePartnerInput = {
  companyId: string
  partnerId: string
  name: string
}
