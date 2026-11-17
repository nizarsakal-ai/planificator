import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { MileageDomainError } from "@/lib/vehicules/mileage-domain"
import { assertMutationOrigin } from "@/lib/vehicules/request-origin"
import { recalculateTourKmNow } from "@/lib/vehicules/v3/tour-km-auto-service"

const headers = { "Cache-Control": "private, no-store" }

/** POST /api/trucks/{id}/tours/{tourId}/auto-km — recalcul immédiat des km automatiques (ADMIN / SUPER_ADMIN). */
export async function POST(request: Request, context: { params: Promise<{ id: string; tourId: string }> }) {
  try {
    assertMutationOrigin(request)
    const p = await context.params
    const result = await recalculateTourKmNow(p.id, p.tourId, { auth, db: prisma })
    return Response.json(result, { headers })
  } catch (e) {
    return Response.json(
      { code: e instanceof MileageDomainError ? e.code : "SERVER_ERROR", error: "Recalcul impossible" },
      { status: e instanceof MileageDomainError ? e.status : 500, headers },
    )
  }
}
