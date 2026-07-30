import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { getAcquisitionOpsSnapshot } from "@/lib/acquisition/ops/acquisition-ops-snapshot"
import { getAcquisitionStagingReadiness } from "@/lib/acquisition/ops/acquisition-staging-readiness"

/**
 * PLAN-ACQ-V2 Lot H — Snapshot ops Acquisition (ADMIN / SUPER_ADMIN).
 * GET /api/acquisition/ops-snapshot
 */
export async function GET() {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  const companyId = session.user.companyId
  if (!companyId) {
    return NextResponse.json({ error: "companyId missing" }, { status: 400 })
  }

  const [ops, readiness] = await Promise.all([
    getAcquisitionOpsSnapshot(companyId),
    getAcquisitionStagingReadiness(companyId),
  ])

  return NextResponse.json({ ops, readiness })
}
