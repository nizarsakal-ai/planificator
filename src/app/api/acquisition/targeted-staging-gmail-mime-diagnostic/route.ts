import { handleTargetedStagingGmailMimeDiagnostic } from "@/lib/acquisition/connector/targeted-staging-gmail-mime-diagnostic.handler"

/**
 * POST /api/acquisition/targeted-staging-gmail-mime-diagnostic
 * Harness temporaire Preview — fail-closed, cible unique via env, métadonnées MIME image/* uniquement.
 */
export async function POST(req: Request): Promise<Response> {
  return handleTargetedStagingGmailMimeDiagnostic(req)
}
