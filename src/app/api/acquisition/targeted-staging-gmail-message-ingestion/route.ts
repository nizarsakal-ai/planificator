import { handleTargetedStagingGmailMessageIngestion } from "@/lib/acquisition/connector/targeted-staging-gmail-message-ingestion.handler"

/**
 * POST /api/acquisition/targeted-staging-gmail-message-ingestion
 * Harness temporaire Preview — ingestion normale d'UN message Gmail réel ciblé, fail-closed.
 */
export async function POST(req: Request): Promise<Response> {
  return handleTargetedStagingGmailMessageIngestion(req)
}
