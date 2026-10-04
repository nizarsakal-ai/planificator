import { handleStagingOrchestratorTrigger } from "@/lib/acquisition/staging/acquisition-staging-orchestrator-trigger.handler"

/** Même budget que /api/cron/acquisition-orchestrator. */
export const maxDuration = 300

/**
 * POST /api/acquisition/staging/orchestrator-trigger — TEMPORAIRE, Preview release/acquisition-core uniquement.
 * Aucun GET exporté : Next.js répond 405 sans exécuter de run.
 */
export async function POST(req: Request) {
  return handleStagingOrchestratorTrigger(req)
}
