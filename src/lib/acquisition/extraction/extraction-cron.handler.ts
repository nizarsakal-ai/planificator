import { NextResponse } from "next/server"
import { assertCronBearerAuth } from "@/lib/cron/assert-cron-bearer-auth"
import { getExtractionCronConfig } from "@/lib/acquisition/extraction/extraction-cron-feature-flag"
import { runAcquisitionExtractionCronOrchestratorDefault } from "@/lib/acquisition/extraction/extraction-cron.orchestrator"
import type { ExtractionCronRunResult } from "@/lib/acquisition/extraction/extraction-cron.orchestrator.types"

export interface ExtractionCronRouteDeps {
  runOrchestrator?: () => Promise<ExtractionCronRunResult>
}

async function defaultRunOrchestrator(): Promise<ExtractionCronRunResult> {
  return runAcquisitionExtractionCronOrchestratorDefault({
    config: getExtractionCronConfig(),
  })
}

export async function handleAcquisitionExtractionCron(
  req: Request,
  deps: ExtractionCronRouteDeps = {}
): Promise<Response> {
  const unauthorized = assertCronBearerAuth(req)
  if (unauthorized) return unauthorized

  const result = await (deps.runOrchestrator ?? defaultRunOrchestrator)()
  return NextResponse.json(result)
}
