import { handleProspectionWatchCron } from "@/lib/prospection/prospection-cron.handler"

/** Collecte quotidienne : quelques requêtes HTTP publiques et des écritures en base, bien en deçà de 120 s. */
export const maxDuration = 120

/** GET /api/cron/prospection-veille — veille prospection (V1), inactive par défaut. Planifiée une fois par jour dans vercel.json. */
export async function GET(req: Request) {
  return handleProspectionWatchCron(req)
}
