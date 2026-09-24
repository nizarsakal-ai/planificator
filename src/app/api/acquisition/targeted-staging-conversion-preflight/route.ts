import { handleTargetedStagingConversionPreflight } from "@/lib/acquisition/conversion/targeted-staging-conversion-preflight.handler"

export const runtime = "nodejs"

export async function POST(req: Request): Promise<Response> {
  return handleTargetedStagingConversionPreflight(req)
}
