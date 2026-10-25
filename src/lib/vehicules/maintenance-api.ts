import { readImportBoundedBody } from "./import-bounded-body"
import { assertMutationOrigin } from "./request-origin"
import { MileageDomainError } from "./mileage-domain"
import { preauthorizeMaintenanceCorrection, correctMaintenance, readMaintenance, recordMaintenance, updateMaintenancePlan, type MaintenanceServiceDeps } from "./maintenance-service"
const headers = { "Cache-Control": "private, no-store" }
function failure(error: unknown) {
  if (error instanceof MileageDomainError) return Response.json({ code: error.code, error: "Opération d’entretien refusée" }, { status: error.status, headers })
  return Response.json({ code: "SERVER_ERROR", error: "Erreur serveur" }, { status: 500, headers })
}
async function payload(request: Request) {
  try { return await request.json() as unknown } catch { throw new MileageDomainError("INVALID_JSON", 400) }
}
export async function handleMaintenanceGet(truckId: string, deps: MaintenanceServiceDeps) {
  try { return Response.json(await readMaintenance(truckId, deps), { headers }) } catch (error) { return failure(error) }
}
export async function handleMaintenancePost(request: Request, truckId: string, deps: MaintenanceServiceDeps) {
  try {
    const result = await recordMaintenance(truckId, await payload(request), request.headers.get("Idempotency-Key"), deps)
    return Response.json({ entryId: result.entryId }, { status: 201, headers: { ...headers, "Idempotency-Replayed": String(result.replayed) } })
  } catch (error) { return failure(error) }
}
export async function handleMaintenancePlanPut(request: Request, truckId: string, deps: MaintenanceServiceDeps) {
  try { return Response.json(await updateMaintenancePlan(truckId, await payload(request), deps), { headers }) } catch (error) { return failure(error) }
}

export async function handleMaintenanceCorrectionPost(request: Request, truckId: string, entryId: string, deps: MaintenanceServiceDeps) {
  try {
    assertMutationOrigin(request)
    await preauthorizeMaintenanceCorrection(truckId, entryId, deps)
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new MileageDomainError("INVALID_CONTENT_TYPE", 415)
    const bytes = await readImportBoundedBody(request, { maxBytes: 32768 })
    let body: unknown
    try { body = JSON.parse(bytes.toString("utf8")) } catch { throw new MileageDomainError("INVALID_JSON", 400) }
    const result = await correctMaintenance(truckId, entryId, body, request.headers.get("Idempotency-Key"), deps)
    return Response.json({ entryId: result.entryId }, { status: 201, headers: { ...headers, "Idempotency-Replayed": String(result.replayed) } })
  } catch (error) { return failure(error) }
}
