import { handleTargetedStagingValidationRecord } from "@/lib/acquisition/orchestrator/targeted-staging-validation-record.handler"

export const runtime = "nodejs"

export async function POST(req: Request): Promise<Response> {
  return handleTargetedStagingValidationRecord(req)
}
