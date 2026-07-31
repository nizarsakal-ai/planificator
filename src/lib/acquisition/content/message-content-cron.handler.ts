import { NextResponse } from "next/server"
import { assertCronBearerAuth } from "@/lib/cron/assert-cron-bearer-auth"
import { getContentCronConfig } from "@/lib/acquisition/content/content-cron-feature-flag"
import { runAcquisitionContentCronOrchestratorDefault } from "@/lib/acquisition/content/message-content-cron.orchestrator"
import type { ContentCronRunResult } from "@/lib/acquisition/content/message-content-cron.orchestrator.types"

export interface ContentCronRouteDeps {
  runOrchestrator?: () => Promise<ContentCronRunResult>
}

async function defaultRunOrchestrator(): Promise<ContentCronRunResult> {
  return runAcquisitionContentCronOrchestratorDefault({
    config: getContentCronConfig(),
  })
}

export async function handleAcquisitionContentFetchCron(
  req: Request,
  deps: ContentCronRouteDeps = {}
): Promise<Response> {
  const unauthorized = assertCronBearerAuth(req)
  if (unauthorized) return unauthorized

  const result = await (deps.runOrchestrator ?? defaultRunOrchestrator)()
  return NextResponse.json(result)
}
