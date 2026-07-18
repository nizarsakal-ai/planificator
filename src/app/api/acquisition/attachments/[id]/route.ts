import { handleAcquisitionAttachmentAccess } from "@/lib/acquisition/access/attachment-access.handler"

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params
  return handleAcquisitionAttachmentAccess(req, id)
}
