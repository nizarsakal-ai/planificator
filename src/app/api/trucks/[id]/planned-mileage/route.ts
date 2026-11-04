import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { MileageDomainError } from "@/lib/vehicules/mileage-domain"
import { readPlannedMileage, type PlannedMileageDeps } from "@/lib/vehicules/planned-mileage-service"

const headers = { "Cache-Control": "private, no-store" }

// Kilométrage prévu par chantier : estimation en lecture seule, drapeau serveur désactivé par défaut.
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
  deps: PlannedMileageDeps = { auth, db: prisma },
) {
  try {
    const month = new URL(request.url).searchParams.get("month")
    return Response.json(await readPlannedMileage((await context.params).id, month, deps), { headers })
  } catch (error) {
    if (error instanceof MileageDomainError)
      return Response.json({ code: error.code, error: "Kilométrage prévu indisponible" }, { status: error.status, headers })
    return Response.json({ code: "SERVER_ERROR", error: "Erreur serveur" }, { status: 500, headers })
  }
}
