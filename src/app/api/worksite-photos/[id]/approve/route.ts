import { handlePhotoApprove } from "@/lib/worksite-photos/photo.api"
import { productionPhotoDeps } from "@/lib/worksite-photos/photo.deps"

// LOT-ADMIN-REVIEW — validation interne d'une photo par un SUPER_ADMIN (n'envoie rien au client).
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params
  return handlePhotoApprove(request, id, productionPhotoDeps())
}
