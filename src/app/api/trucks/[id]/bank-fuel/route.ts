import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { MileageDomainError } from "@/lib/vehicules/mileage-domain"
import { readBankFuel } from "@/lib/vehicules/v3/bank-fuel-service"

export const dynamic = "force-dynamic"
const headers = { "Cache-Control": "private, no-store" }

/** GET /api/trucks/{id}/bank-fuel?from=AAAA-MM-JJ&to=AAAA-MM-JJ — pleins détectés dans les relevés bancaires (lecture seule). */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const params = new URL(request.url).searchParams
    const result = await readBankFuel((await context.params).id, { from: params.get("from"), to: params.get("to") }, { auth, db: prisma })
    return Response.json(result, { headers })
  } catch (e) {
    return Response.json(
      { code: e instanceof MileageDomainError ? e.code : "SERVER_ERROR", error: "Pleins bancaires indisponibles" },
      { status: e instanceof MileageDomainError ? e.status : 500, headers },
    )
  }
}
