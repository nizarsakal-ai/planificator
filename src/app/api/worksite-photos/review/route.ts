import { handleReviewList } from "@/lib/worksite-photos/photo.api"
import { productionPhotoDeps } from "@/lib/worksite-photos/photo.deps"

// LOT-ADMIN-REVIEW — galerie de contrôle SUPER_ADMIN : filtres chantier et état, pagination par curseur, aucune donnée Drive.
export async function GET(request: Request): Promise<Response> {
  return handleReviewList(request, productionPhotoDeps())
}
