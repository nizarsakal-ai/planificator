import { handleTargetedStagingInlineAttachmentNeutralization } from "@/lib/acquisition/attachments/targeted-staging-inline-attachment-neutralization.handler"

/**
 * POST /api/acquisition/targeted-staging-inline-attachment-neutralization
 * Harness temporaire Preview — fail-closed, 6 pièces inline historiques exactes (manifest en code).
 */
export async function POST(req: Request): Promise<Response> {
  return handleTargetedStagingInlineAttachmentNeutralization(req)
}
