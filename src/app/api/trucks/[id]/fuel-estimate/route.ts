import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { MileageDomainError } from "@/lib/vehicules/mileage-domain"
import { readFuelEstimate, type FuelEstimateDeps } from "@/lib/vehicules/v3/fuel-estimate-service"

export const dynamic = "force-dynamic"

const headers = { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" }

// V3 — estimation carburant d'un trajet (?tripId=… ou ?stayId=…, &fuel=GAZOLE) : kilomètres, stations du trajet et prix publics.
// Décisions d'estimation (&mode=, &gaps=, &depot=1, &handover=) : hypothèses vérifiées puis rendues, jamais enregistrées. Lecture seule.
// Prévision (&forecast=1&context=…, séjour sans aucune décision) : itinéraire et prix seulement, aucune déclaration supposée.
export async function GET(request: Request, context: { params: Promise<{ id: string }> }, deps: FuelEstimateDeps = { auth, db: prisma }) {
  try {
    const url = new URL(request.url)
    const p = (name: string) => url.searchParams.get(name)
    const estimate = await readFuelEstimate((await context.params).id, { tripId: p("tripId"), stayId: p("stayId"), fuel: p("fuel"), mode: p("mode"), gaps: p("gaps"), depot: p("depot"), handover: p("handover"), context: p("context"), forecast: p("forecast") }, deps)
    return Response.json(estimate, { headers })
  } catch (error) {
    const known = error instanceof MileageDomainError
    return Response.json({ code: known ? error.code : "SERVER_ERROR", error: "Estimation refusée" }, { status: known ? error.status : 500, headers })
  }
}
