/**
 * PLAN-ACQ-V2 Lot I — Spécifications de seed registre (données, pas code pipeline).
 * LAURALU n’est qu’un exemple de seed ops — zéro littéral dans l’orchestrateur.
 */

export type PartnerRegistrySeedSpec = {
  code: string
  name: string
  domains: string[]
  emails?: string[]
  pipeline?: string
  priority?: number
  requireExactEmail?: boolean
  autoApproveEnabled?: boolean
  autoConvertEnabled?: boolean
  allowCreateClient?: boolean
  minConfidence?: number | null
}

/**
 * Seed ops historique de continuité cutover — **donnée configurable**,
 * pas une dépendance architecture. Remplaçable / extensible sans toucher le pipeline.
 */
export const DEFAULT_CONSULTATION_PARTNER_SEEDS: PartnerRegistrySeedSpec[] = [
  {
    code: "lauralu",
    name: "LAURALU",
    domains: ["lauralu.fr"],
    pipeline: "consultations",
    priority: 100,
    requireExactEmail: false,
    autoApproveEnabled: false,
    autoConvertEnabled: false,
    allowCreateClient: false,
  },
]

/** @deprecated aliases — compat scripts/tests cutover. */
export const LAURALU_PARTNER_CODE = "lauralu" as const
export const LAURALU_PARTNER_NAME = "LAURALU" as const
export const LAURALU_PARTNER_PIPELINE = "consultations" as const
export const LAURALU_DOMAIN_NORMALIZED = "lauralu.fr" as const
