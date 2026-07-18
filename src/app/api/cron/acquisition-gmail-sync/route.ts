import { handleAcquisitionGmailSyncCron } from "@/lib/acquisition/connector/acquisition-gmail-sync.handler"

/** GET /api/cron/acquisition-gmail-sync — driver cron Acquisition Gmail (inactif par défaut). */
export async function GET(req: Request) {
  return handleAcquisitionGmailSyncCron(req)
}
