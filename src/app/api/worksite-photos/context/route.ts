import { handleContextGet } from "@/lib/worksite-photos/photo.api"
import { productionPhotoDeps } from "@/lib/worksite-photos/photo.deps"

// SPEC-WORKSITE-PHOTOS-001 Lot 3 — chantiers photographiables (filtres d'affectation du rôle) et engins actifs.
export async function GET(request: Request): Promise<Response> {
  return handleContextGet(request, productionPhotoDeps())
}
