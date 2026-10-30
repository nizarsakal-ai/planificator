import { handlePhotoUpload } from "@/lib/worksite-photos/photo.api"
import { productionPhotoDeps } from "@/lib/worksite-photos/photo.deps"

// SPEC-WORKSITE-PHOTOS-001 Lot 3 — upload d'une photo d'engin : identifiants dans le chemin, pré-autorisation
// avant lecture du corps, réservation avec bail et identifiant Drive préalloué. Wrapper fin : métier dans photo.service.
export async function POST(request: Request, context: { params: Promise<{ worksiteId: string; truckId: string }> }): Promise<Response> {
  const { worksiteId, truckId } = await context.params
  return handlePhotoUpload(request, { worksiteId, truckId }, productionPhotoDeps())
}
