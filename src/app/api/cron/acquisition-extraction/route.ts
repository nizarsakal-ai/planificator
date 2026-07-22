import { handleAcquisitionExtractionCron } from "@/lib/acquisition/extraction/extraction-cron.handler"

/**
 * Budget Vercel : couvre `ACQUISITION_EXTRACTION_CRON_MAX_DURATION_MS` (défaut 240s)
 * avec marge réseau/cold start. Non déclaré dans vercel.json (scheduler externe).
 */
export const maxDuration = 300

/** GET /api/cron/acquisition-extraction — worker extraction (inactif par défaut via flags). */
export async function GET(req: Request) {
  return handleAcquisitionExtractionCron(req)
}
