import { handleTargetedStagingGmailOAuthProfile } from "@/lib/acquisition/connector/targeted-staging-gmail-oauth-profile.handler"

/**
 * POST /api/acquisition/targeted-staging-gmail-oauth-profile
 * Harness temporaire Preview — identité OAuth (users/me/profile) de la connexion Gmail Acquisition ciblée.
 */
export async function POST(req: Request): Promise<Response> {
  return handleTargetedStagingGmailOAuthProfile(req)
}
