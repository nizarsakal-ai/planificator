import { NextResponse } from "next/server"
import { assertCronBearerAuth } from "@/lib/cron/assert-cron-bearer-auth"
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
  const unauthorized = assertCronBearerAuth(req)
  if (unauthorized) return unauthorized

  const result = await (deps.runDriver ?? defaultRunDriver)()
  return NextResponse.json(result)
}
