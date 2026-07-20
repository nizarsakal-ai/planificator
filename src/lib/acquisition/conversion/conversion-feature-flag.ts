/**
 * PLAN-ACQ-005D — Flag conversion métier (défaut OFF).
 */
export function isAcquisitionConversionEnabled(): boolean {
  return process.env.ACQUISITION_CONVERSION_ENABLED === "true"
}

/** Master + conversion requis pour convertir un draft APPROVED. */
export function isAcquisitionConversionFullyEnabled(): boolean {
  return (
    process.env.PLANIFICATOR_ACQUISITION_ENABLED === "true" &&
    process.env.ACQUISITION_CONVERSION_ENABLED === "true"
  )
}
