import { handleAcquisitionOrchestratorCron } from "@/lib/acquisition/orchestrator/acquisition-orchestrator.handler"

/**
 * Budget Vercel : couvre `ACQUISITION_ORCHESTRATOR_MAX_DURATION_MS` (défaut 240s)
 * avec marge réseau/cold start. Non déclaré dans vercel.json (scheduler externe).
 */
export const maxDuration = 300

/** GET /api/cron/acquisition-orchestrator — fondation V2 (stubs, inactif par défaut). */
export async function GET(req: Request) {
  return handleAcquisitionOrchestratorCron(req)
}
