import { handlePhotoFile } from "@/lib/worksite-photos/photo.api"
import { productionPhotoDeps } from "@/lib/worksite-photos/photo.deps"

// SPEC-WORKSITE-PHOTOS-001 Lot 3 — proxy privé du fichier (affichage) : droits relus, audit avant flux, aucune URL Drive.
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params
  return handlePhotoFile(request, id, productionPhotoDeps())
}
