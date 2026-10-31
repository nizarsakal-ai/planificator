import { handlePhotoTrash } from "@/lib/worksite-photos/photo.api"
import { productionPhotoDeps } from "@/lib/worksite-photos/photo.deps"

// LOT-ADMIN-REVIEW — suppression vers la corbeille Drive par un SUPER_ADMIN (deux phases, reprise après panne, jamais définitive).
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params
  return handlePhotoTrash(request, id, productionPhotoDeps())
}
