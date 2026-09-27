import { handleTargetedStagingAutoDecisionPreflight } from "@/lib/acquisition/orchestrator/targeted-staging-auto-decision-preflight.handler"

export const runtime = "nodejs"

export async function POST(req: Request): Promise<Response> {
  return handleTargetedStagingAutoDecisionPreflight(req)
}
