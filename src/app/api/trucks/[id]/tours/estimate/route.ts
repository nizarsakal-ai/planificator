import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { MileageDomainError } from "@/lib/vehicules/mileage-domain"
import { assertMutationOrigin } from "@/lib/vehicules/request-origin"
import { estimateTourKm } from "@/lib/vehicules/v3/tour-km-estimate-service"

const headers = { "Cache-Control": "private, no-store" }

/** POST /api/trucks/{id}/tours/estimate — estimation des kilomètres d'une tournée de chantier (lecture seule). */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertMutationOrigin(request)
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
      throw new MileageDomainError("INVALID_CONTENT_TYPE", 415)
    const length = Number(request.headers.get("content-length") ?? "0")
    if (length > 10_000) throw new MileageDomainError("PAYLOAD_TOO_LARGE", 413)
    let body: unknown
    try { body = JSON.parse((await request.text()).slice(0, 10_000)) } catch { throw new MileageDomainError("INVALID_JSON", 400) }
    const result = await estimateTourKm((await context.params).id, body, { auth, db: prisma })
    return Response.json(result, { headers })
  } catch (e) {
    return Response.json(
      { code: e instanceof MileageDomainError ? e.code : "SERVER_ERROR", error: "Estimation impossible" },
      { status: e instanceof MileageDomainError ? e.status : 500, headers },
    )
  }
}
