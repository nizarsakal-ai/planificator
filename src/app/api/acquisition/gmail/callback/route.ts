import { NextRequest } from "next/server"
import {
  defaultAcquisitionGmailCallbackDeps,
  handleAcquisitionGmailCallback,
} from "@/lib/acquisition/connector/acquisition-gmail-oauth-callback"

/**
 * Callback OAuth Gmail Acquisition.
 * Upsert par (companyId, gmailAddress) → multi-compte ; jamais gmail_connections.
 * GET /api/acquisition/gmail/callback
 */
export async function GET(req: NextRequest) {
  return handleAcquisitionGmailCallback(req, defaultAcquisitionGmailCallbackDeps())
}
