/** Adaptateurs HTTP du ticket du chauffeur (V3 : drapeau, origine de confiance, erreurs normalisées). */
import { readDocumentMultipart } from "./document-api"
import { v3Route } from "./v3-http"
import { MileageDomainError } from "../mileage-domain"
import { readMyTrucks, recognizeDriverTicket, submitDriverTicket, type DriverTicketDeps } from "./driver-fuel-ticket-service"

const headers = { "Cache-Control": "private, no-store" }

export function handleMyTrucks(request: Request, deps: DriverTicketDeps) {
  return v3Route(request, async () => Response.json(await readMyTrucks(deps), { headers }))
}

export function handleDriverTicketRecognize(request: Request, deps: DriverTicketDeps) {
  return v3Route(request, async () => {
    const { body, file } = await readDocumentMultipart(request, deps.env)
    const truckId = (body as { truckId?: unknown } | null)?.truckId
    if (typeof truckId !== "string" || !truckId.trim()) throw new MileageDomainError("INVALID_PAYLOAD", 400)
    return Response.json(await recognizeDriverTicket(truckId.trim(), file, deps), { headers })
  })
}

export function handleDriverTicketSubmit(request: Request, deps: DriverTicketDeps) {
  return v3Route(request, async () => {
    const { body, file } = await readDocumentMultipart(request, deps.env)
    const result = await submitDriverTicket(body, file, request.headers.get("Idempotency-Key"), deps)
    return Response.json(result, { status: result.replayed ? 200 : 201, headers })
  })
}
