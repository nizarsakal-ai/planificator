import { handleTargetedStagingPdfText } from "@/lib/acquisition/extraction/targeted-staging-pdf-text.handler"

/**
 * POST /api/acquisition/targeted-staging-pdf-text
 * Harness temporaire Preview — lecture ciblée couche texte d'un PLAN PDF STORED.
 */
export async function POST(req: Request): Promise<Response> {
  return handleTargetedStagingPdfText(req)
}
