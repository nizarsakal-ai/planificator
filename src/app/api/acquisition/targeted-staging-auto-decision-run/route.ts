import { handleTargetedStagingAutoDecisionRun } from "@/lib/acquisition/orchestrator/targeted-staging-auto-decision-run.handler"

export const runtime = "nodejs"

export async function POST(req: Request): Promise<Response> {
  return handleTargetedStagingAutoDecisionRun(req)
}
