import { handleTargetedStagingGmailListDiagnostic } from "@/lib/acquisition/connector/targeted-staging-gmail-list-diagnostic.handler"

/**
 * POST /api/acquisition/targeted-staging-gmail-list-diagnostic
 * Harness temporaire Preview — compare des requêtes Gmail messages.list fixes (cas Penven), fail-closed.
 */
export async function POST(req: Request): Promise<Response> {
  return handleTargetedStagingGmailListDiagnostic(req)
}
