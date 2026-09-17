import { handleTargetedStagingAttachmentRecovery } from "@/lib/acquisition/attachments/targeted-staging-attachment-recovery.handler"

/**
 * POST /api/acquisition/targeted-staging-attachment-recovery
 * Harness temporaire Preview — recovery ciblé FAILED → DISCOVERED, fail-closed.
 */
export async function POST(req: Request): Promise<Response> {
  return handleTargetedStagingAttachmentRecovery(req)
}
