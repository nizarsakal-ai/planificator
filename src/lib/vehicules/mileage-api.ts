/** Adaptateurs HTTP testables du cœur Lot 1. Aucune route Next publique n'est activée. */
import { MileageDomainError, type MileageCommandType } from "./mileage-domain"
import { executeMileageCommand, readMileage, type MileageServiceDeps } from "./mileage-service"

const headers = { "Cache-Control": "private, no-store" }

function failure(error: unknown): Response {
  if (error instanceof MileageDomainError)
    return Response.json({ code: error.code, error: "Opération kilométrique refusée" }, { status: error.status, headers })
  return Response.json({ code: "SERVER_ERROR", error: "Erreur serveur" }, { status: 500, headers })
}

export async function handleMileageGet(truckId: string, deps: MileageServiceDeps): Promise<Response> {
  try {
    return Response.json(await readMileage(truckId, deps), { headers })
  } catch (error) {
    return failure(error)
  }
}

export async function handleMileageCommand(
  request: Request,
  target: { truckId: string; action: MileageCommandType; targetId?: string },
  deps: MileageServiceDeps,
): Promise<Response> {
  try {
    let body: unknown
    try { body = await request.json() } catch { throw new MileageDomainError("INVALID_JSON", 400) }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new MileageDomainError("INVALID_PAYLOAD", 400)
    if ("entryId" in body || "tripId" in body) throw new MileageDomainError("INVALID_PAYLOAD", 400)
    const input = target.action === "END" ? { ...body, tripId: target.targetId }
      : target.action === "CORRECTION" ? { ...body, entryId: target.targetId } : body
    const result = await executeMileageCommand(target.truckId, target.action, input, request.headers.get("Idempotency-Key"), deps)
    return Response.json(result.receipt, {
      status: result.status,
      headers: { ...headers, "Idempotency-Replayed": String(result.replayed) },
    })
  } catch (error) {
    return failure(error)
  }
}
