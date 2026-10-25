import type { Prisma } from "@prisma/client"
import { consumeApprovedImportInTransaction } from "../import-service"

/** Called only within an already-authorized vehicle command transaction. */
export const consumeVehicleTourImport = consumeApprovedImportInTransaction

/** Historical versions remain usable as evidence; ownership must match exactly. */
export async function validateVehicleExpenseDocument(
  tx: Prisma.TransactionClient,
  scope: { companyId: string; truckId: string; versionId: string },
): Promise<boolean> {
  const version = await tx.vehicleDocumentVersion.findFirst({
    where: { id: scope.versionId, companyId: scope.companyId, truckId: scope.truckId },
    select: { id: true },
  })
  return version !== null
}
