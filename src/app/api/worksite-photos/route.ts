import { handlePhotosList } from "@/lib/worksite-photos/photo.api"
import { productionPhotoDeps } from "@/lib/worksite-photos/photo.deps"

// SPEC-WORKSITE-PHOTOS-001 Lot 3 — photos visibles par l'acteur (chantiers accessibles), paginées, sans URL Drive.
export async function GET(request: Request): Promise<Response> {
  return handlePhotosList(request, productionPhotoDeps())
}
