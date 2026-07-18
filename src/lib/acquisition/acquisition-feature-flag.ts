/**
 * Feature flag du module Assistant Consultations.
 * Activer avec PLANIFICATOR_ACQUISITION_ENABLED=true.
 */
export function isAcquisitionEnabled(): boolean {
  return process.env.PLANIFICATOR_ACQUISITION_ENABLED === "true"
}
