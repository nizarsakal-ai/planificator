import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { MileageDomainError } from "@/lib/vehicules/mileage-domain"
import { listPlannedStays, type FuelEstimateDeps } from "@/lib/vehicules/v3/fuel-estimate-service"

export const dynamic = "force-dynamic"

const headers = { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" }

// V3 — séjours planifiés du camion (chantier, départ, retour, équipe, chef, chauffeur) proposés à l'estimation carburant.
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }, deps: FuelEstimateDeps = { auth, db: prisma }) {
  try {
    return Response.json(await listPlannedStays((await context.params).id, deps), { headers })
  } catch (error) {
    const known = error instanceof MileageDomainError
    return Response.json({ code: known ? error.code : "SERVER_ERROR", error: "Séjours indisponibles" }, { status: known ? error.status : 500, headers })
  }
}
