import { NextResponse } from "next/server"
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
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const result = await (deps.runOrchestrator ?? defaultRunOrchestrator)()
  return NextResponse.json(result)
}
