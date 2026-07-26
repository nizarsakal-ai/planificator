/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1A / STEP-4
 * Pipeline registry V1 minimal (IMPL §21).
 *
 * Un seul pipeline : `consultations`.
 * `admit` est un port typé — aucune implémentation métier ici.
 */

import type {
  PipelineAdmission,
  PipelineIdV1,
} from "@/lib/integration/contracts/pipeline-admission"
import { PIPELINE_ID_CONSULTATIONS } from "@/lib/integration/contracts/pipeline-admission"

/**
 * Handler d’admission injecté plus tard par l’adapter consultations.
 * Ne crée aucun Draft dans ce module.
 */
export type PipelineAdmitHandler = (
  admission: PipelineAdmission
) => void | Promise<void>

export type ConsultationsPipelineRegistration = {
  readonly pipelineId: typeof PIPELINE_ID_CONSULTATIONS
  readonly admit: PipelineAdmitHandler
}

export type PipelineRegistry = {
  readonly consultations: ConsultationsPipelineRegistration
  get(pipelineId: PipelineIdV1): ConsultationsPipelineRegistration
}

export const PIPELINE_REGISTRY_ERROR = {
  UNKNOWN_PIPELINE: "PIPELINE_REGISTRY_UNKNOWN_PIPELINE",
} as const

export class PipelineRegistryError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = "PipelineRegistryError"
    this.code = code
  }
}

/**
 * Registry V1 figé sur `consultations`, avec handler `admit` injecté.
 */
export function createPipelineRegistry(input: {
  readonly admit: PipelineAdmitHandler
}): PipelineRegistry {
  const consultations: ConsultationsPipelineRegistration = Object.freeze({
    pipelineId: PIPELINE_ID_CONSULTATIONS,
    admit: input.admit,
  })

  return Object.freeze({
    consultations,
    get(pipelineId: PipelineIdV1) {
      if (pipelineId !== PIPELINE_ID_CONSULTATIONS) {
        throw new PipelineRegistryError(PIPELINE_REGISTRY_ERROR.UNKNOWN_PIPELINE)
      }
      return consultations
    },
  })
}
