import { NextResponse } from "next/server"
import { syncAcquisitionMailForCompany } from "@/lib/acquisition/connector/acquisition-gmail-sync.service"
import {
  runAcquisitionGmailSyncDriver,
  type AcquisitionGmailCronRunResult,
} from "@/lib/acquisition/connector/acquisition-gmail-sync.driver"
import { createGmailMailProviderAdapter } from "@/lib/acquisition/connector/gmail-mail-provider.adapter"
import { acquisitionIngestionAdapter } from "@/lib/acquisition/ports/acquisition-ingestion.adapter"
import { acquisitionScanCursorRepository } from "@/lib/acquisition/persistence/acquisition-scan-cursor.repository"
import { gmailConnectionListingAdapter } from "@/lib/acquisition/persistence/gmail-connection-listing.adapter"

export interface AcquisitionGmailSyncRouteDeps {
  runDriver?: () => Promise<AcquisitionGmailCronRunResult>
}

async function defaultRunDriver(): Promise<AcquisitionGmailCronRunResult> {
  return runAcquisitionGmailSyncDriver({
    listCompanyIds: () => gmailConnectionListingAdapter.listCompanyIdsWithGmailConnection(),
    runSyncForCompany: (companyId) =>
      syncAcquisitionMailForCompany({
        companyId,
        provider: createGmailMailProviderAdapter(),
        ingestion: acquisitionIngestionAdapter,
        cursorRepository: acquisitionScanCursorRepository,
      }),
  })
}

export async function handleAcquisitionGmailSyncCron(
  req: Request,
  deps: AcquisitionGmailSyncRouteDeps = {}
): Promise<Response> {
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const result = await (deps.runDriver ?? defaultRunDriver)()
  return NextResponse.json(result)
}
