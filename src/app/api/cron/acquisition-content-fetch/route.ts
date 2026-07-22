import { handleAcquisitionContentFetchCron } from "@/lib/acquisition/content/message-content-cron.handler"

/**
 * Budget Vercel : couvre `ACQUISITION_CONTENT_CRON_MAX_DURATION_MS` (défaut 240s)
 * avec marge réseau/cold start. Non déclaré dans vercel.json (scheduler externe).
 */
export const maxDuration = 300

/** GET /api/cron/acquisition-content-fetch — worker content (inactif par défaut via flags). */
export async function GET(req: Request) {
  return handleAcquisitionContentFetchCron(req)
}
