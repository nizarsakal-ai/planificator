/**
 * État dérivé UI (pas un statut Prisma) : données obligatoires pour validation.
 */
export function isPendingReady(p: {
  address: string | null | undefined
  startDate: Date | string | null | undefined
  endDate: Date | string | null | undefined
}): boolean {
  return Boolean(
    (typeof p.address === "string" ? p.address.trim() : p.address) &&
      p.startDate &&
      p.endDate
  )
}
