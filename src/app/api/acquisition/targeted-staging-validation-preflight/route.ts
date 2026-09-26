import { handleTargetedStagingValidationPreflight } from "@/lib/acquisition/capabilities/targeted-staging-validation-preflight.handler"

export const runtime = "nodejs"

export async function POST(req: Request): Promise<Response> {
  return handleTargetedStagingValidationPreflight(req)
}
