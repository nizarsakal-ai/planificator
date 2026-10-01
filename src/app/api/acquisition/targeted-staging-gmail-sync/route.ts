import { handleTargetedStagingGmailSync } from "@/lib/acquisition/connector/targeted-staging-gmail-sync.handler"

/**
 * POST /api/acquisition/targeted-staging-gmail-sync
 * Harness temporaire Preview — fail-closed, une seule connexion Gmail Acquisition ciblée via env.
 */
export async function POST(req: Request): Promise<Response> {
  return handleTargetedStagingGmailSync(req)
}
