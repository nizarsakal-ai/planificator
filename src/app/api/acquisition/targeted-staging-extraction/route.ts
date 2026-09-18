import { handleTargetedStagingExtraction } from "@/lib/acquisition/extraction/targeted-staging-extraction.handler"

export const runtime = "nodejs"

export async function POST(req: Request): Promise<Response> {
  return handleTargetedStagingExtraction(req)
}
