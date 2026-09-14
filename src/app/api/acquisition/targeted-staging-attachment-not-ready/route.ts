import { handleTargetedStagingAttachmentNotReady } from "@/lib/acquisition/extraction/targeted-staging-attachment-not-ready.handler"

/**
 * POST /api/acquisition/targeted-staging-attachment-not-ready
 * Harness temporaire Preview — fail-closed, cible unique via env.
 */
export async function POST(req: Request): Promise<Response> {
  return handleTargetedStagingAttachmentNotReady(req)
}
