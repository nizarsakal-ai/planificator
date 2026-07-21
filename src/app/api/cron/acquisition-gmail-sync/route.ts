import { handleAcquisitionGmailSyncCron } from "@/lib/acquisition/connector/acquisition-gmail-sync.handler"

/** Budget Vercel (Pro) : marge au-dessus des syncs multi-tenant. */
export const maxDuration = 300

/** GET /api/cron/acquisition-gmail-sync — driver cron Acquisition Gmail (inactif par défaut via flags). */
export async function GET(req: Request) {
  return handleAcquisitionGmailSyncCron(req)
}
