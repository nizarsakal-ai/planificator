import { NextResponse } from "next/server"
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
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const result = await (deps.runOrchestrator ?? defaultRunOrchestrator)()
  return NextResponse.json(result)
}
