import { handleTargetedStagingAttachmentDownload } from "@/lib/acquisition/attachments/targeted-staging-attachment-download.handler"

/**
 * POST /api/acquisition/targeted-staging-attachment-download
 * Harness temporaire Preview — téléchargement ciblé d'un PLAN, fail-closed.
 */
export async function POST(req: Request): Promise<Response> {
  return handleTargetedStagingAttachmentDownload(req)
}
