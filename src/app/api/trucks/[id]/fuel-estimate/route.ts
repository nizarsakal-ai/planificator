import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { MileageDomainError } from "@/lib/vehicules/mileage-domain"
import { readFuelEstimate, type FuelEstimateDeps } from "@/lib/vehicules/v3/fuel-estimate-service"

export const dynamic = "force-dynamic"

const headers = { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" }

// V3 — estimation carburant d'un trajet (?tripId=… ou ?stayId=…, &fuel=GAZOLE) : kilomètres, stations du trajet et prix publics. Lecture seule.
export async function GET(request: Request, context: { params: Promise<{ id: string }> }, deps: FuelEstimateDeps = { auth, db: prisma }) {
  try {
    const url = new URL(request.url)
    const estimate = await readFuelEstimate((await context.params).id, { tripId: url.searchParams.get("tripId"), stayId: url.searchParams.get("stayId"), fuel: url.searchParams.get("fuel") }, deps)
    return Response.json(estimate, { headers })
  } catch (error) {
    const known = error instanceof MileageDomainError
    return Response.json({ code: known ? error.code : "SERVER_ERROR", error: "Estimation refusée" }, { status: known ? error.status : 500, headers })
  }
}
