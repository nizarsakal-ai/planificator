import { handleTargetedStagingConsultationDetection } from "@/lib/acquisition/capabilities/targeted-staging-consultation-detection.handler"

/**
 * POST /api/acquisition/targeted-staging-consultation-detection
 * Harness temporaire Preview — preuve de détection ciblée (un seul draft) via la capability réelle.
 */
export async function POST(req: Request): Promise<Response> {
  return handleTargetedStagingConsultationDetection(req)
}
